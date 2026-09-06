'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const { CLINICA_PADRAO, normalizarConvenios } = require('../clinic');

function emptyState() {
  return {
    contacts: [],
    messages: [],
    reminders: [],
    bookings: [],
    events: [],
    campaigns: [],
    waitlist: [],
    users: [],
    sessions: [],
    clinic: structuredClone(CLINICA_PADRAO),
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
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { ...emptyState(), ...parsed };
      this.state.clinic = {
        ...CLINICA_PADRAO,
        ...(parsed.clinic || {}),
        policies: { ...CLINICA_PADRAO.policies, ...((parsed.clinic || {}).policies || {}) },
      };
      // Bancos gravados antes do cadastro de convênios guardavam só os nomes.
      this.state.clinic.insurances = normalizarConvenios(this.state.clinic.insurances);
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

  /** Persiste e avisa o painel de que algo mudou. */
  commit(type, payload) {
    this.save();
    this.emit('change', { type, payload });
  }

  get clinic() {
    return this.state.clinic;
  }

  // ---------- pacientes ----------

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
      birthDate: null,
      insurance: null,
      createdAt: new Date().toISOString(),
      lastInboundAt: null,
      lastOutboundAt: null,
      stage: 'novo',
      priority: 'normal',
      lastReadMessageId: null,
      privacyNoticeSentAt: null,
      state: { step: 'inicio', data: {} },
      optOut: false,
      notes: [],
    };
    this.state.contacts.push(contact);
    this.commit('contact', contact);
    return contact;
  }

  /**
   * Mensagens do paciente ainda não vistas pela recepção.
   *
   * A marca é o id da última mensagem lida, não um horário: duas mensagens no
   * mesmo milissegundo fariam a contagem por relógio perder uma delas.
   */
  naoLidas(contactId) {
    const recebidas = this.state.messages.filter(
      (m) => m.contactId === contactId && m.direction === 'in',
    );
    const contato = this.getContact(contactId);
    if (!contato || !recebidas.length) return 0;
    if (!contato.lastReadMessageId) return recebidas.length;

    const posicao = recebidas.findIndex((m) => m.id === contato.lastReadMessageId);
    return posicao === -1 ? recebidas.length : recebidas.length - posicao - 1;
  }

  marcarLida(contactId) {
    const contato = this.getContact(contactId);
    if (!contato) return null;
    const recebidas = this.state.messages.filter(
      (m) => m.contactId === contactId && m.direction === 'in',
    );
    contato.lastReadMessageId = recebidas.length ? recebidas[recebidas.length - 1].id : null;
    this.commit('contact', contato);
    return contato;
  }

  addNote(contactId, text) {
    const contact = this.getContact(contactId);
    if (!contact) return null;
    const note = { at: new Date().toISOString(), text };
    contact.notes.push(note);
    this.commit('contact', contact);
    return note;
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

  // ---------- consultas ----------

  addBooking(booking) {
    const full = {
      id: crypto.randomUUID(),
      status: 'confirmado',        // situacao do horario na agenda
      confirmation: 'aguardando',  // presenca confirmada pelo paciente
      attendance: null,            // 'compareceu' | 'faltou'
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

  // ---------- lista de espera ----------

  addWaitlistEntry(entry) {
    const full = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'aguardando',
      offer: null,
      ...entry,
    };
    this.state.waitlist.push(full);
    this.commit('waitlist', full);
    return full;
  }

  // ---------- disparos ----------

  addCampaign(campaign) {
    const full = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pendente',
      sent: 0,
      failed: 0,
      skipped: 0,
      ...campaign,
    };
    this.state.campaigns.push(full);
    if (this.state.campaigns.length > 100) this.state.campaigns.splice(0, this.state.campaigns.length - 100);
    this.commit('campaign', full);
    return full;
  }

  getCampaign(id) {
    return this.state.campaigns.find((c) => c.id === id) || null;
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

module.exports = { Store, emptyState };
