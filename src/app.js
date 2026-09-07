'use strict';

const { Store } = require('./db/store');
const { Agenda } = require('./core/agenda');
const { Reminders } = require('./core/reminders');
const { Bot } = require('./core/bot');
const { Broadcast } = require('./core/broadcast');
const { Waitlist } = require('./core/waitlist');
const { Auth } = require('./core/auth');
const { Retencao } = require('./core/privacy');
const { GoogleCalendar } = require('./integrations/google');
const { MockChannel } = require('./channels/mock');
const { WhatsAppWebChannel } = require('./channels/whatsappWeb');

function createChannel(config) {
  if (config.channel === 'whatsapp') return new WhatsAppWebChannel(config);
  return new MockChannel();
}

/** Monta o bot inteiro (armazenamento, agenda, lembretes, canal) e liga as pecas. */
function createApp(config, { channel } = {}) {
  const store = new Store(config.dataFile);
  const agenda = new Agenda(store, config);
  const chan = channel || createChannel(config);

  // Mensagens longas ganham uma pausa proporcional ao tamanho, como alguem
  // digitando do outro lado. So vale no canal real.
  const pausar = async (text) => {
    const base = config.typingDelayMs || 0;
    if (!base || chan.name === 'mock' || chan.name === 'test') return;
    const espera = Math.min(base + text.length * 12, 4000);
    await new Promise((resolve) => setTimeout(resolve, espera));
  };

  /**
   * Envia e registra. Se o envio falhar, a mensagem entra no histórico marcada
   * como não entregue: some do WhatsApp, mas não some do painel — a recepção
   * precisa ver o que o paciente deixou de receber.
   */
  const sendText = async (phone, text) => {
    const contact = store.upsertContact(phone);
    await pausar(text);
    try {
      await chan.sendText(phone, text);
    } catch (err) {
      store.addMessage(contact.id, 'out', text, { channel: chan.name, erro: err.message });
      store.logEvent('erro', `Não entregue para ${contact.name || contact.phone}: ${err.message}`);
      throw err;
    }
    return store.addMessage(contact.id, 'out', text, { channel: chan.name });
  };

  const reminders = new Reminders(store, config, sendText, agenda);
  const bot = new Bot(store, agenda, reminders, config);
  const broadcast = new Broadcast(store, agenda, config, sendText);
  const waitlist = new Waitlist(store, agenda, config, sendText);
  const auth = new Auth(store, config);
  auth.garantirUsuarioPadrao();
  const retencao = new Retencao(store, config);
  bot.waitlist = waitlist;

  // Quanto tempo o bot fica calado depois de conectar é decisão da recepção, e
  // ela muda isso pelo painel — não por SSH no .env do servidor.
  if (typeof chan.definirJanelaDeSilencio === 'function') {
    chan.definirJanelaDeSilencio(() => {
      const minutos = Number(store.clinic.connectQuietMinutes);
      if (Number.isFinite(minutos) && minutos >= 0) return minutos * 60000;
      return (Number(config.connectQuietSeconds) || 300) * 1000;
    });
  }

  // Google Agenda: a consulta marcada aqui aparece no calendário do médico, e
  // o compromisso que ele marcou no celular deixa de ser oferecido ao paciente.
  const google = new GoogleCalendar(store, config);
  agenda.ocupadosExternos = (dateStr, professionalId) => google.ocupadosEm(dateStr, professionalId);

  // Toda mudança de consulta passa por commit('booking'): é o único ponto que
  // precisa saber do Google. A fila serializa os envios — dois refreshes de
  // token ao mesmo tempo custam uma chamada recusada.
  let fila = Promise.resolve();
  store.on('change', ({ type, payload }) => {
    if (type !== 'booking' || !payload || !google.ativo()) return;
    fila = fila
      .then(() => google.sincronizar(payload))
      .then(() => store.save())
      .catch((err) => console.error('[google]', err.message));
  });
  google.fila = () => fila;

  // Horário desmarcado é vaga: quem está esperando ouve primeiro.
  agenda.onSlotFreed = (booking) => {
    waitlist.emAndamento = waitlist.oferecerVaga(waitlist.vagaDe(booking))
      .catch((err) => console.error('[espera]', err));
  };

  const handleIncoming = async ({ phone, name, body, mediaType = null, antiga = false }) => {
    const replies = await bot.handleIncoming({ phone, name, body, mediaType, antiga });
    let falha = null;
    for (const reply of replies) {
      try {
        await sendText(phone, reply);
      } catch (err) {
        // A conversa não pode ser perdida por causa do canal: as respostas
        // ficam registradas e o erro sobe uma vez só, já em português.
        falha = falha || err;
      }
    }
    if (falha) throw falha;
    return replies;
  };

  chan.onMessage = handleIncoming;

  return {
    config, store, agenda, reminders, bot, broadcast, waitlist, auth, retencao, google,
    channel: chan, sendText, handleIncoming,
  };
}

module.exports = { createApp, createChannel };
