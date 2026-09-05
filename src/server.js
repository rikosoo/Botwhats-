'use strict';

const path = require('path');
const express = require('express');

function createServer(app) {
  const { store, agenda, reminders, bot, channel, config } = app;
  const server = express();
  server.use(express.json());
  server.use(express.static(path.join(__dirname, '..', 'public')));

  const clients = new Set();

  store.on('change', (change) => {
    const payload = `data: ${JSON.stringify({ type: change.type })}\n\n`;
    for (const res of clients) res.write(payload);
  });

  /** Snapshot completo usado pelo painel. */
  function snapshot() {
    return {
      businessName: config.businessName,
      timezone: config.timezone,
      channel: { name: channel.name, status: channel.status, qr: channel.qr || null },
      offsets: { followUp: config.followUpOffsets, booking: config.bookingOffsets },
      contacts: store.state.contacts.map((c) => ({
        ...c,
        messageCount: store.messagesOf(c.id).length,
        lastMessage: store.messagesOf(c.id).slice(-1)[0] || null,
      })),
      messages: store.state.messages.slice(-800),
      reminders: store.state.reminders,
      bookings: store.state.bookings,
      events: store.state.events.slice(-100).reverse(),
      availability: store.state.availability,
      agendaDays: agenda.nextAvailableDays(7),
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
    const { phone, name, body } = req.body || {};
    if (!phone || !body) return res.status(400).json({ error: 'informe phone e body' });
    try {
      const replies = await app.handleIncoming({ phone: String(phone), name: name || null, body: String(body) });
      return res.json({ replies });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Mensagem manual do atendente para o contato.
  server.post('/api/messages', async (req, res) => {
    const { contactId, body } = req.body || {};
    const contact = store.getContact(contactId);
    if (!contact) return res.status(404).json({ error: 'contato nao encontrado' });
    if (!body) return res.status(400).json({ error: 'informe body' });
    try {
      await app.sendText(contact.phone, String(body));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/slots', (req, res) => {
    const date = req.query.date || agenda.today();
    res.json({ date, slots: agenda.slotsFor(date) });
  });

  server.get('/api/availability', (req, res) => res.json(store.state.availability));

  server.put('/api/availability', (req, res) => {
    const { slotMinutes, weekly, exceptions } = req.body || {};
    const current = store.state.availability;
    if (slotMinutes) current.slotMinutes = Number(slotMinutes);
    if (weekly) current.weekly = weekly;
    if (exceptions) current.exceptions = exceptions;
    store.commit('availability', current);
    store.logEvent('agenda', 'Horarios de atendimento atualizados pelo painel');
    res.json(current);
  });

  server.post('/api/bookings', (req, res) => {
    const { contactId, date, start, note } = req.body || {};
    const contact = store.getContact(contactId);
    if (!contact) return res.status(404).json({ error: 'contato nao encontrado' });
    try {
      const booking = agenda.book(contactId, date, start, note || '');
      reminders.scheduleBookingReminders(booking);
      store.cancelReminders((r) => r.contactId === contactId && r.kind === 'followup');
      store.logEvent('agendamento', `Agendamento criado pelo painel para ${contact.name || contact.phone}`);
      return res.json(booking);
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
  });

  server.delete('/api/bookings/:id', (req, res) => {
    const booking = agenda.cancel(req.params.id);
    if (!booking) return res.status(404).json({ error: 'agendamento nao encontrado' });
    store.logEvent('cancelamento', 'Agendamento cancelado pelo painel');
    return res.json(booking);
  });

  server.post('/api/reminders/:id/send', async (req, res) => {
    const reminder = store.getReminder(req.params.id);
    if (!reminder || reminder.status !== 'pending') {
      return res.status(404).json({ error: 'lembrete nao encontrado ou ja processado' });
    }
    reminder.dueAt = new Date().toISOString();
    await reminders.tick();
    return res.json(store.getReminder(req.params.id));
  });

  server.delete('/api/reminders/:id', (req, res) => {
    const reminder = store.getReminder(req.params.id);
    if (!reminder) return res.status(404).json({ error: 'lembrete nao encontrado' });
    reminder.status = 'cancelado';
    store.commit('reminder', reminder);
    return res.json(reminder);
  });

  server.post('/api/contacts/:id/followups', (req, res) => {
    const contact = store.getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contato nao encontrado' });
    const created = reminders.scheduleFollowUps(contact);
    return res.json(created);
  });

  server.get('/api/health', (req, res) => res.json({
    ok: true,
    channel: channel.name,
    status: channel.status,
    contatos: store.state.contacts.length,
    lembretesPendentes: store.state.reminders.filter((r) => r.status === 'pending').length,
  }));

  return { server, bot, snapshot };
}

module.exports = { createServer };
