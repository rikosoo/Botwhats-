'use strict';

const { Store } = require('./db/store');
const { Agenda } = require('./core/agenda');
const { Reminders } = require('./core/reminders');
const { Bot } = require('./core/bot');
const { Broadcast } = require('./core/broadcast');
const { Waitlist } = require('./core/waitlist');
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

  const sendText = async (phone, text) => {
    const contact = store.upsertContact(phone);
    await pausar(text);
    await chan.sendText(phone, text);
    return store.addMessage(contact.id, 'out', text, { channel: chan.name });
  };

  const reminders = new Reminders(store, config, sendText);
  const bot = new Bot(store, agenda, reminders, config);
  const broadcast = new Broadcast(store, agenda, config, sendText);
  const waitlist = new Waitlist(store, agenda, config, sendText);
  bot.waitlist = waitlist;

  // Horário desmarcado é vaga: quem está esperando ouve primeiro.
  agenda.onSlotFreed = (booking) => {
    waitlist.emAndamento = waitlist.oferecerVaga(waitlist.vagaDe(booking))
      .catch((err) => console.error('[espera]', err));
  };

  const handleIncoming = async ({ phone, name, body, mediaType = null }) => {
    const replies = await bot.handleIncoming({ phone, name, body, mediaType });
    for (const reply of replies) await sendText(phone, reply);
    return replies;
  };

  chan.onMessage = handleIncoming;

  return {
    config, store, agenda, reminders, bot, broadcast, waitlist,
    channel: chan, sendText, handleIncoming,
  };
}

module.exports = { createApp, createChannel };
