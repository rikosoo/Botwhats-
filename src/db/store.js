'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const DEFAULT_AVAILABILITY = {
  slotMinutes: 60,
  // 0 = domingo ... 6 = sabado
  weekly: {
    0: [],
    1: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
    2: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
    3: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
    4: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
    5: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '17:00' }],
    6: [],
  },
  // { 'YYYY-MM-DD': [] } fecha o dia; com faixas, substitui o horario padrao
  exceptions: {},
};

function emptyState() {
  return {
    contacts: [],
    messages: [],
    reminders: [],
    bookings: [],
    events: [],
    availability: structuredClone(DEFAULT_AVAILABILITY),
  };
}

class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.state = emptyState();
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.state = { ...emptyState(), ...parsed };
        this.state.availability = {
          ...DEFAULT_AVAILABILITY,
          ...(parsed.availability || {}),
          weekly: { ...DEFAULT_AVAILABILITY.weekly, ...((parsed.availability || {}).weekly || {}) },
          exceptions: { ...((parsed.availability || {}).exceptions || {}) },
        };
      }
    } catch (err) {
      console.error('[store] falha ao ler o banco, iniciando vazio:', err.message);
      this.state = emptyState();
    }
  }

  /** Grava em disco de forma atomica, agrupando escritas proximas. */
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 50);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  saveNow() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Aplica uma mudanca, persiste e notifica o painel. */
  commit(type, payload) {
    this.save();
    this.emit('change', { type, payload });
  }

  // ---------- contatos ----------

  findContactByPhone(phone) {
    return this.state.contacts.find((c) => c.phone === phone) || null;
  }

  getContact(id) {
    return this.state.contacts.find((c) => c.id === id) || null;
  }

  upsertContact(phone, name) {
    let contact = this.findContactByPhone(phone);
    if (contact) {
      if (name && !contact.name) contact.name = name;
      return contact;
    }
    contact = {
      id: crypto.randomUUID(),
      phone,
      name: name || null,
      createdAt: new Date().toISOString(),
      lastInboundAt: null,
      lastOutboundAt: null,
      stage: 'novo',
      state: { step: 'inicio', data: {} },
      optOut: false,
    };
    this.state.contacts.push(contact);
    this.commit('contact', contact);
    return contact;
  }

  // ---------- mensagens ----------

  addMessage(contactId, direction, body, meta = {}) {
    const message = {
      id: crypto.randomUUID(),
      contactId,
      direction,
      body,
      at: new Date().toISOString(),
      meta,
    };
    this.state.messages.push(message);
    const contact = this.getContact(contactId);
    if (contact) {
      if (direction === 'in') contact.lastInboundAt = message.at;
      else contact.lastOutboundAt = message.at;
    }
    this.commit('message', message);
    return message;
  }

  messagesOf(contactId) {
    return this.state.messages.filter((m) => m.contactId === contactId);
  }

  // ---------- lembretes ----------

  addReminder(reminder) {
    const full = {
      id: crypto.randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      sentAt: null,
      ...reminder,
    };
    this.state.reminders.push(full);
    this.commit('reminder', full);
    return full;
  }

  getReminder(id) {
    return this.state.reminders.find((r) => r.id === id) || null;
  }

  cancelReminders(filter) {
    let count = 0;
    for (const reminder of this.state.reminders) {
      if (reminder.status !== 'pending') continue;
      if (!filter(reminder)) continue;
      reminder.status = 'cancelado';
      count += 1;
    }
    if (count) this.commit('reminder', null);
    return count;
  }

  // ---------- agendamentos ----------

  addBooking(booking) {
    const full = {
      id: crypto.randomUUID(),
      status: 'confirmado',
      createdAt: new Date().toISOString(),
      ...booking,
    };
    this.state.bookings.push(full);
    this.commit('booking', full);
    return full;
  }

  getBooking(id) {
    return this.state.bookings.find((b) => b.id === id) || null;
  }

  bookingsOf(contactId) {
    return this.state.bookings.filter((b) => b.contactId === contactId);
  }

  // ---------- linha do tempo do painel ----------

  logEvent(type, text) {
    const event = { id: crypto.randomUUID(), at: new Date().toISOString(), type, text };
    this.state.events.push(event);
    if (this.state.events.length > 500) this.state.events.splice(0, this.state.events.length - 500);
    this.commit('event', event);
    return event;
  }
}

module.exports = { Store, DEFAULT_AVAILABILITY, emptyState };
