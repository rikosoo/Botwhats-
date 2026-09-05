'use strict';

const path = require('path');
const express = require('express');

const { SEGMENTOS, VARIAVEIS } = require('./core/broadcast');
const { indicadores } = require('./core/metrics');
const { normalizarConvenios, conveniosAtivos } = require('./clinic');

function createServer(app) {
  const { store, agenda, reminders, broadcast, waitlist, channel, config } = app;
  const server = express();
  server.use(express.json());
  server.use(express.static(path.join(__dirname, '..', 'public')));

  const clients = new Set();
  store.on('change', (change) => {
    const payload = `data: ${JSON.stringify({ type: change.type })}\n\n`;
    for (const res of clients) res.write(payload);
  });

  /** Snapshot completo usado pelo painel da recepção. */
  function snapshot() {
    const hoje = agenda.today();
    return {
      clinic: { ...store.clinic, conveniosAtivos: conveniosAtivos(store.clinic) },
      timezone: config.timezone,
      hoje,
      aberto: agenda.isOpenNow(),
      channel: { name: channel.name, status: channel.status, qr: channel.qr || null },
      offsets: { followUp: config.followUpOffsets, booking: config.bookingOffsets },
      contacts: store.state.contacts.map((c) => ({
        ...c,
        messageCount: store.messagesOf(c.id).length,
        lastMessage: store.messagesOf(c.id).slice(-1)[0] || null,
        nextBooking: agenda.nextBookingOf(c.id),
      })),
      messages: store.state.messages.slice(-800),
      reminders: store.state.reminders,
      bookings: store.state.bookings,
      events: store.state.events.slice(-120).reverse(),
      campaigns: store.state.campaigns.slice(-20).reverse(),
      segments: Object.entries(SEGMENTOS).map(([id, seg]) => ({
        id,
        label: seg.label,
        descricao: seg.descricao,
        total: broadcast.segmentar(id).length,
      })),
      variables: Object.keys(VARIAVEIS),
      broadcastLimits: { delayMs: config.broadcastDelayMs, max: config.broadcastMaxRecipients },
      dayView: agenda.dayView(hoje),
      waitlist: store.state.waitlist
        .filter((e) => ['aguardando', 'oferecido'].includes(e.status))
        .map((e, i) => ({ ...e, posicao: i + 1 })),
      metrics: indicadores(store),
      agendaDays: agenda.nextAvailableDays(7, {
        professionalId: store.clinic.professionals[0] && store.clinic.professionals[0].id,
      }),
    };
  }

  server.get('/api/state', (req, res) => res.json(snapshot()));

  server.get('/api/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  // Simulador: injeta uma mensagem como se tivesse chegado do WhatsApp.
  server.post('/api/simulate', async (req, res) => {
    const { phone, name, body, mediaType } = req.body || {};
    if (!phone || (!body && !mediaType)) return res.status(400).json({ error: 'informe phone e body' });
    try {
      const replies = await app.handleIncoming({
        phone: String(phone),
        name: name || null,
        body: String(body || ''),
        mediaType: mediaType || null,
      });
      return res.json({ replies });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Mensagem manual da recepção.
  server.post('/api/messages', async (req, res) => {
    const { contactId, body } = req.body || {};
    const contact = store.getContact(contactId);
    if (!contact) return res.status(404).json({ error: 'paciente não encontrado' });
    if (!body) return res.status(400).json({ error: 'informe body' });
    try {
      await app.sendText(contact.phone, String(body));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---------- pacientes ----------

  server.patch('/api/contacts/:id', (req, res) => {
    const contact = store.getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'paciente não encontrado' });
    for (const campo of ['name', 'birthDate', 'insurance', 'priority', 'stage']) {
      if (req.body && req.body[campo] !== undefined) contact[campo] = req.body[campo];
    }
    if (req.body && req.body.note) store.addNote(contact.id, req.body.note);
    store.commit('contact', contact);
    return res.json(contact);
  });

  server.post('/api/contacts/:id/followups', (req, res) => {
    const contact = store.getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'paciente não encontrado' });
    return res.json(reminders.scheduleFollowUps(contact));
  });

  // Devolve a conversa para o bot depois do atendimento humano.
  server.post('/api/contacts/:id/release', (req, res) => {
    const contact = store.getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'paciente não encontrado' });
    contact.state = { step: 'conversa', data: {} };
    contact.stage = contact.stage === 'atendimento humano' ? 'ativo' : contact.stage;
    store.logEvent('handoff', `${contact.name || contact.phone} devolvido ao atendimento automático`);
    store.commit('contact', contact);
    return res.json(contact);
  });

  // ---------- agenda ----------

  server.get('/api/slots', (req, res) => {
    const date = req.query.date || agenda.today();
    res.json({
      date,
      slots: agenda.slotsFor(date, {
        professionalId: req.query.professionalId,
        serviceId: req.query.serviceId,
      }),
    });
  });

  server.get('/api/day', (req, res) => {
    const date = req.query.date || agenda.today();
    res.json({ date, agenda: agenda.dayView(date) });
  });

  server.post('/api/bookings', (req, res) => {
    const { contactId, professionalId, serviceId, date, start, insurance, note } = req.body || {};
    const contact = store.getContact(contactId);
    if (!contact) return res.status(404).json({ error: 'paciente não encontrado' });
    try {
      const booking = agenda.book(contactId, { professionalId, serviceId, date, start, insurance, note });
      reminders.scheduleBookingReminders(booking);
      store.cancelReminders((r) => r.contactId === contactId && r.kind === 'followup');
      store.logEvent('agendamento', `Consulta criada pela recepção para ${contact.name || contact.phone}`);
      return res.json(booking);
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
  });

  server.delete('/api/bookings/:id', (req, res) => {
    const booking = agenda.cancel(req.params.id, 'cancelado pela recepção');
    if (!booking) return res.status(404).json({ error: 'consulta não encontrada' });
    store.logEvent('cancelamento', 'Consulta cancelada pela recepção');
    return res.json(booking);
  });

  // Confirmação de presença e comparecimento (fecha o ciclo do lembrete).
  server.post('/api/bookings/:id/status', (req, res) => {
    const booking = store.getBooking(req.params.id);
    if (!booking) return res.status(404).json({ error: 'consulta não encontrada' });
    const { confirmation, attendance } = req.body || {};
    const contact = store.getContact(booking.contactId);

    if (confirmation) {
      booking.confirmation = confirmation;
      if (confirmation === 'confirmado') booking.confirmedAt = new Date().toISOString();
    }
    if (attendance) {
      booking.attendance = attendance;
      if (attendance === 'compareceu') {
        reminders.scheduleReturnReminder(booking);
        const checkIn = reminders.scheduleCheckIn(booking);
        store.logEvent('atendimento', `${contact ? contact.name : ''} compareceu`
          + `${checkIn ? ' — check-in de amanhã e retorno programados' : ' — retorno programado'}`);
      }
      if (attendance === 'faltou') {
        reminders.scheduleNoShowReminder(booking);
        store.logEvent('falta', `${contact ? contact.name : ''} faltou à consulta`);
      }
    }
    store.commit('booking', booking);
    return res.json(booking);
  });

  // ---------- lista de espera ----------

  server.post('/api/waitlist', (req, res) => {
    const { contactId, serviceId, professionalId, nota } = req.body || {};
    const contact = store.getContact(contactId);
    if (!contact) return res.status(404).json({ error: 'paciente não encontrado' });
    return res.json(waitlist.adicionar(contactId, { serviceId, professionalId, nota }));
  });

  server.delete('/api/waitlist/:id', (req, res) => {
    const entrada = waitlist.remover(req.params.id, 'removido');
    if (!entrada) return res.status(404).json({ error: 'entrada não encontrada' });
    store.logEvent('espera', 'Nome retirado da lista de espera pela recepção');
    return res.json(entrada);
  });

  // ---------- lembretes ----------

  server.post('/api/reminders/:id/send', async (req, res) => {
    const reminder = store.getReminder(req.params.id);
    if (!reminder || reminder.status !== 'pending') {
      return res.status(404).json({ error: 'lembrete não encontrado ou já processado' });
    }
    reminder.dueAt = new Date().toISOString();
    await reminders.tick();
    return res.json(store.getReminder(req.params.id));
  });

  server.delete('/api/reminders/:id', (req, res) => {
    const reminder = store.getReminder(req.params.id);
    if (!reminder) return res.status(404).json({ error: 'lembrete não encontrado' });
    reminder.status = 'cancelado';
    store.commit('reminder', reminder);
    return res.json(reminder);
  });

  // ---------- disparo de mensagens ----------

  // Quem está em cada segmento (id, nome, telefone, situação).
  server.get('/api/segments/:id', (req, res) => {
    if (!SEGMENTOS[req.params.id]) return res.status(404).json({ error: 'segmento não encontrado' });
    const contatos = broadcast.segmentar(req.params.id).map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      stage: c.stage,
      optOut: c.optOut,
      insurance: c.insurance,
      lastInboundAt: c.lastInboundAt,
      nextBooking: agenda.nextBookingOf(c.id),
    }));
    return res.json({ segmento: req.params.id, total: contatos.length, contatos });
  });

  // Prévia: quantos recebem, quem fica de fora e como o texto fica preenchido.
  server.post('/api/broadcast/preview', (req, res) => {
    const { contactIds = [], body = '' } = req.body || {};
    return res.json(broadcast.previa(contactIds, body));
  });

  server.post('/api/broadcast', (req, res) => {
    const { contactIds = [], body, segmento = null, scheduledAt = null } = req.body || {};
    try {
      const campanha = broadcast.criar({ contactIds, texto: body, segmento, scheduledAt });
      return res.json(campanha);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  // Cancela um disparo agendado que ainda não saiu.
  server.delete('/api/broadcast/:id', (req, res) => {
    const campanha = store.getCampaign(req.params.id);
    if (!campanha) return res.status(404).json({ error: 'disparo não encontrado' });
    if (campanha.status !== 'agendado') {
      return res.status(409).json({ error: 'só dá para cancelar disparo ainda agendado' });
    }
    const cancelados = store.cancelReminders((r) => r.campaignId === campanha.id);
    campanha.status = 'cancelado';
    store.commit('campaign', campanha);
    store.logEvent('disparo', `Disparo agendado cancelado (${cancelados} mensagem(ns))`);
    return res.json(campanha);
  });

  // ---------- consultório ----------

  server.get('/api/metrics', (req, res) => res.json(indicadores(store, Number(req.query.dias) || 30)));

  server.get('/api/clinic', (req, res) => res.json(store.clinic));

  server.put('/api/clinic', (req, res) => {
    if (req.body && req.body.insurances) {
      // Aceita ["Unimed"] ou [{ name, active }] e grava sempre no formato novo.
      req.body.insurances = normalizarConvenios(req.body.insurances);
    }
    const permitido = [
      'name', 'specialty', 'assistantName', 'address', 'addressHint', 'mapsUrl', 'phone',
      'hoursText', 'insurances', 'acceptsInsurance', 'privatePrice', 'paymentInfo',
      'documents', 'services', 'policies',
    ];
    for (const campo of permitido) {
      if (req.body && req.body[campo] !== undefined) store.clinic[campo] = req.body[campo];
    }
    store.commit('clinic', store.clinic);
    store.logEvent('config', 'Dados do consultório atualizados');
    return res.json(store.clinic);
  });

  server.put('/api/professionals/:id', (req, res) => {
    const profissional = store.clinic.professionals.find((p) => p.id === req.params.id);
    if (!profissional) return res.status(404).json({ error: 'profissional não encontrado' });
    for (const campo of ['name', 'specialty', 'crm', 'slotMinutes', 'weekly', 'exceptions']) {
      if (req.body && req.body[campo] !== undefined) profissional[campo] = req.body[campo];
    }
    store.commit('clinic', store.clinic);
    store.logEvent('agenda', `Agenda de ${profissional.name} atualizada`);
    return res.json(profissional);
  });

  server.get('/api/health', (req, res) => res.json({
    ok: true,
    channel: channel.name,
    status: channel.status,
    aberto: agenda.isOpenNow(),
    pacientes: store.state.contacts.length,
    consultasHoje: store.state.bookings.filter((b) => b.date === agenda.today() && b.status === 'confirmado').length,
    lembretesPendentes: store.state.reminders.filter((r) => r.status === 'pending').length,
  }));

  return { server, snapshot };
}

module.exports = { createServer };
