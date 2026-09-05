'use strict';

const { Store } = require('./db/store');
const { Agenda } = require('./core/agenda');
const { Reminders } = require('./core/reminders');
const { Bot } = require('./core/bot');
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

  const sendText = async (phone, text) => {
    const contact = store.upsertContact(phone);
    await chan.sendText(phone, text);
    return store.addMessage(contact.id, 'out', text, { channel: chan.name });
  };

  const reminders = new Reminders(store, config, sendText);
  const bot = new Bot(store, agenda, reminders, config);

  const handleIncoming = async ({ phone, name, body }) => {
    const replies = await bot.handleIncoming({ phone, name, body });
    for (const reply of replies) await sendText(phone, reply);
    return replies;
  };

  chan.onMessage = handleIncoming;

  return { config, store, agenda, reminders, bot, channel: chan, sendText, handleIncoming };
}

module.exports = { createApp, createChannel };
