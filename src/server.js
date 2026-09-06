'use strict';

const path = require('path');
const express = require('express');

const { SEGMENTOS, VARIAVEIS } = require('./core/broadcast');
const { indicadores } = require('./core/metrics');
const { exportarPaciente, apagarPaciente } = require('./core/privacy');
const { CAMPOS: CAMPOS_DE_MENSAGEM, sanitizar: sanitizarMensagens } = require('./core/templates');
const { normalizarConvenios, conveniosAtivos } = require('./clinic');

function createServer(app) {
  const { store, agenda, reminders, broadcast, waitlist, auth, channel, config } = app;
  const server = express();
  server.use(express.json());
  // O painel é atualizado junto com o código: sem isto, o navegador continua
  // servindo o CSS e o JS antigos e a atualização "não aparece".
  server.use(express.static(path.join(__dirname, '..', 'public'), {
    etag: true,
    maxAge: 0,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // Sinal de vida para monitoramento, sem contar nada sobre pacientes.
  server.get('/api/ping', (req, res) => res.json({ ok: true, channel: channel.name, status: channel.status }));

  const COOKIE = 'botwhats_sessao';

  function lerCookie(req, nome) {
    const bruto = req.headers.cookie || '';
    for (const parte of bruto.split(';')) {
      const [chave, ...resto] = parte.trim().split('=');
      if (chave === nome) return decodeURIComponent(resto.join('='));
    }
    return null;
  }

  function definirCookie(res, token, dias) {
    const partes = [
      `${COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.round(dias * 24 * 3600)}`,
    ];
    if (config.cookieSecure) partes.push('Secure');
    res.setHeader('Set-Cookie', partes.join('; '));
  }

  // ---------- login ----------

  server.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const resultado = auth.entrar(username, password);
    if (resultado.erro) return res.status(401).json({ error: resultado.erro });
    definirCookie(res, resultado.token, config.sessionDays || 7);
    store.logEvent('acesso', `${resultado.usuario.username} entrou no painel`);
    return res.json({ user: resultado.usuario });
  });

  server.post('/api/logout', (req, res) => {
    auth.sair(lerCookie(req, COOKIE));
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    return res.json({ ok: true });
  });

  server.get('/api/session', (req, res) => {
    const usuario = auth.usuarioDoToken(lerCookie(req, COOKIE));
    return res.json({ user: usuario ? auth.publico(usuario) : null });
  });

  /**
   * Daqui para baixo tudo exige sessão. O painel é a única porta para os dados
   * dos pacientes, então a regra é fechada por padrão: rota nova nasce protegida.
   */
  server.use('/api', (req, res, next) => {
    const usuario = auth.usuarioDoToken(lerCookie(req, COOKIE));
    if (!usuario) return res.status(401).json({ error: 'Faça login para continuar' });
    req.usuario = usuario;
    return next();
  });

  server.post('/api/account/password', (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const resultado = auth.trocarSenha(req.usuario, currentPassword, newPassword);
    if (resultado.erro) return res.status(400).json({ error: resultado.erro });
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    return res.json({ ok: true, relogin: true });
  });

  server.post('/api/account/username', (req, res) => {
    const resultado = auth.trocarUsuario(req.usuario, (req.body || {}).username);
    if (resultado.erro) return res.status(400).json({ error: resultado.erro });
    store.logEvent('acesso', `Nome de usuário alterado para ${req.usuario.username}`);
    return res.json({ user: auth.publico(req.usuario) });
  });

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
      offsets: {
        followUp: reminders.regra('followUp', config.followUpOffsets),
        booking: reminders.regra('booking', config.bookingOffsets),
        waitlistOfferMinutes: Math.round(waitlist.prazoMs / 60000),
        scarcityThreshold: reminders.regra('scarcityThreshold', config.scarcityThreshold),
      },
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
      messageFields: CAMPOS_DE_MENSAGEM,
      broadcastLimits: { delayMs: config.broadcastDelayMs, max: config.broadcastMaxRecipients },
      dayView: agenda.dayView(hoje),
      waitlist: store.state.waitlist
        .filter((e) => ['aguardando', 'oferecido'].includes(e.status))
        .map((e, i) => ({ ...e, posicao: i + 1 })),
      metrics: indicadores(store),
      ocupacao: agenda.ocupacao(7),
      agendaDays: agenda.nextAvailableDays(7, {
        professionalId: store.clinic.professionals[0] && store.clinic.professionals[0].id,
      }),
    };
  }

  server.get('/api/state', (req, res) => res.json({ ...snapshot(), user: auth.publico(req.usuario) }));

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

  // LGPD: cópia dos dados (portabilidade) e exclusão a pedido do paciente.
  server.get('/api/contacts/:id/export', (req, res) => {
    const dados = exportarPaciente(store, req.params.id);
    if (!dados) return res.status(404).json({ error: 'paciente não encontrado' });
    store.logEvent('privacidade', `Dados de ${dados.paciente.nome || dados.paciente.telefone} exportados`);
    return res.json(dados);
  });

  server.delete('/api/contacts/:id', (req, res) => {
    const resumo = apagarPaciente(store, req.params.id);
    if (!resumo) return res.status(404).json({ error: 'paciente não encontrado' });
    return res.json(resumo);
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

  // Dias com horário livre para uma combinação de profissional e atendimento.
  server.get('/api/slots-dias', (req, res) => {
    res.json({
      dias: agenda.nextAvailableDays(7, {
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

  // ---------- conexão do WhatsApp ----------

  /**
   * Estado da conexão e o QR Code já desenhado. Ler o código pelo painel evita
   * a parte mais chata de colocar no ar: entrar por SSH e caçar o desenho no log.
   */
  server.get('/api/whatsapp', async (req, res) => {
    const resposta = {
      canal: channel.name,
      status: channel.status,
      conectado: channel.status === 'conectado',
      qrSvg: null,
      qrTexto: channel.qr || null,
    };
    if (channel.qr) {
      try {
        const qrcode = require('qrcode');
        resposta.qrSvg = await qrcode.toString(channel.qr, {
          type: 'svg', margin: 1, width: 260, errorCorrectionLevel: 'M',
        });
      } catch {
        // Sem a biblioteca, o painel mostra o código em texto e o caminho do terminal.
        resposta.qrSvg = null;
      }
    }
    return res.json(resposta);
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
    if (req.body && req.body.messages) {
      req.body.messages = sanitizarMensagens(req.body.messages);
    }
    if (req.body && req.body.insurances) {
      // Aceita ["Unimed"] ou [{ name, active }] e grava sempre no formato novo.
      req.body.insurances = normalizarConvenios(req.body.insurances);
    }
    const permitido = [
      'name', 'specialty', 'assistantName', 'address', 'addressHint', 'mapsUrl', 'phone',
      'hoursText', 'insurances', 'acceptsInsurance', 'privatePrice', 'paymentInfo',
      'documents', 'services', 'policies', 'messages', 'reminders',
    ];
    for (const campo of permitido) {
      if (req.body && req.body[campo] !== undefined) store.clinic[campo] = req.body[campo];
    }
    store.commit('clinic', store.clinic);
    store.logEvent('config', 'Dados do consultório atualizados');
    return res.json(store.clinic);
  });

  /** Identificador estável a partir do nome, sem acento nem espaço. */
  function gerarId(nome, existentes) {
    const base = String(nome).normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
    let id = base;
    let n = 2;
    while (existentes.some((x) => x.id === id)) { id = `${base}-${n}`; n += 1; }
    return id;
  }

  const consultasFuturas = (filtro) => store.state.bookings.filter(
    (b) => b.status === 'confirmado' && new Date(b.startsAt) >= new Date() && filtro(b),
  ).length;

  // ---------- profissionais ----------

  server.post('/api/professionals', (req, res) => {
    const { name, specialty, crm, slotMinutes } = req.body || {};
    if (!name || String(name).trim().length < 3) {
      return res.status(400).json({ error: 'informe o nome do profissional' });
    }
    const profissional = {
      id: gerarId(name, store.clinic.professionals),
      name: String(name).trim(),
      specialty: (specialty || store.clinic.specialty || '').trim(),
      crm: (crm || '').trim(),
      slotMinutes: Number(slotMinutes) || 30,
      weekly: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
      exceptions: {},
    };
    store.clinic.professionals.push(profissional);
    store.commit('clinic', store.clinic);
    store.logEvent('config', `${profissional.name} adicionado à equipe`);
    return res.json(profissional);
  });

  server.put('/api/professionals/:id', (req, res) => {
    const profissional = store.clinic.professionals.find((p) => p.id === req.params.id);
    if (!profissional) return res.status(404).json({ error: 'profissional não encontrado' });
    for (const campo of ['name', 'specialty', 'crm', 'slotMinutes', 'weekly', 'exceptions']) {
      if (req.body && req.body[campo] !== undefined) profissional[campo] = req.body[campo];
    }
    if (profissional.slotMinutes) profissional.slotMinutes = Number(profissional.slotMinutes) || 30;

    // O nome fica gravado na consulta; atualizar mantém a agenda coerente.
    for (const booking of store.state.bookings) {
      if (booking.professionalId === profissional.id) booking.professionalName = profissional.name;
    }
    store.commit('clinic', store.clinic);
    store.logEvent('config', `Cadastro de ${profissional.name} atualizado`);
    return res.json(profissional);
  });

  server.delete('/api/professionals/:id', (req, res) => {
    const profissional = store.clinic.professionals.find((p) => p.id === req.params.id);
    if (!profissional) return res.status(404).json({ error: 'profissional não encontrado' });
    if (store.clinic.professionals.length === 1) {
      return res.status(409).json({ error: 'o consultório precisa de pelo menos um profissional' });
    }
    // Remover alguém com agenda marcada deixaria pacientes sem consulta e sem aviso.
    const marcadas = consultasFuturas((b) => b.professionalId === profissional.id);
    if (marcadas) {
      return res.status(409).json({
        error: `${profissional.name} tem ${marcadas} consulta(s) futura(s). Remarque ou cancele antes de remover.`,
      });
    }
    store.clinic.professionals = store.clinic.professionals.filter((p) => p.id !== profissional.id);
    store.commit('clinic', store.clinic);
    store.logEvent('config', `${profissional.name} removido da equipe`);
    return res.json({ ok: true });
  });

  // ---------- tipos de atendimento ----------

  function normalizarServico(entrada, atual = {}) {
    const servico = { ...atual };
    if (entrada.name !== undefined) servico.name = String(entrada.name).trim();
    if (entrada.durationMin !== undefined) servico.durationMin = Number(entrada.durationMin) || 30;
    if (entrada.returnDays !== undefined) servico.returnDays = Number(entrada.returnDays) || 0;
    if (entrada.price !== undefined) servico.price = String(entrada.price).trim();
    if (entrada.prep !== undefined) servico.prep = String(entrada.prep).trim();
    if (entrada.includes !== undefined) {
      servico.includes = Array.isArray(entrada.includes)
        ? entrada.includes.map((i) => String(i).trim()).filter(Boolean)
        : String(entrada.includes).split('\n').map((i) => i.trim()).filter(Boolean);
    }
    return servico;
  }

  server.post('/api/services', (req, res) => {
    const dados = req.body || {};
    if (!dados.name || String(dados.name).trim().length < 3) {
      return res.status(400).json({ error: 'informe o nome do atendimento' });
    }
    const servico = normalizarServico(dados, {
      id: gerarId(dados.name, store.clinic.services),
      durationMin: 30,
      returnDays: 0,
      includes: [],
      prep: '',
      price: '',
    });
    store.clinic.services.push(servico);
    store.commit('clinic', store.clinic);
    store.logEvent('config', `Atendimento "${servico.name}" criado`);
    return res.json(servico);
  });

  server.put('/api/services/:id', (req, res) => {
    const indice = store.clinic.services.findIndex((s) => s.id === req.params.id);
    if (indice === -1) return res.status(404).json({ error: 'atendimento não encontrado' });
    store.clinic.services[indice] = normalizarServico(req.body || {}, store.clinic.services[indice]);
    store.commit('clinic', store.clinic);
    store.logEvent('config', `Atendimento "${store.clinic.services[indice].name}" atualizado`);
    return res.json(store.clinic.services[indice]);
  });

  server.delete('/api/services/:id', (req, res) => {
    const servico = store.clinic.services.find((s) => s.id === req.params.id);
    if (!servico) return res.status(404).json({ error: 'atendimento não encontrado' });
    if (store.clinic.services.length === 1) {
      return res.status(409).json({ error: 'o consultório precisa de pelo menos um tipo de atendimento' });
    }
    const marcadas = consultasFuturas((b) => b.serviceId === servico.id);
    if (marcadas) {
      return res.status(409).json({
        error: `Há ${marcadas} consulta(s) futura(s) desse tipo. Remarque ou cancele antes de remover.`,
      });
    }
    store.clinic.services = store.clinic.services.filter((s) => s.id !== servico.id);
    store.commit('clinic', store.clinic);
    store.logEvent('config', `Atendimento "${servico.name}" removido`);
    return res.json({ ok: true });
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
