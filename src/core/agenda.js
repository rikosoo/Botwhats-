'use strict';

const { findService, findProfessional } = require('../clinic');

const WEEKDAY_NAMES = [
  'domingo', 'segunda-feira', 'terca-feira', 'quarta-feira',
  'quinta-feira', 'sexta-feira', 'sabado',
];

/** Deslocamento (ms) do fuso em relacao ao UTC no instante informado. */
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUTC - date.getTime();
}

/** Converte data/hora locais do fuso ("2026-09-10", "14:30") para um Date em UTC. */
function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  ts = guess - tzOffsetMs(new Date(ts), timeZone); // segunda passada cobre viradas de horario de verao
  return new Date(ts);
}

function dateKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function timeKey(date, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDaysToKey(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function formatDateBr(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function formatDateLong(dateStr) {
  return `${WEEKDAY_NAMES[weekdayOf(dateStr)]}, ${formatDateBr(dateStr)}`;
}

/** "amanha", "quinta-feira (10/09)" — formato curto e natural para o paciente. */
function formatDateFriendly(dateStr, hoje) {
  if (dateStr === hoje) return `hoje (${formatDateBr(dateStr).slice(0, 5)})`;
  if (dateStr === addDaysToKey(hoje, 1)) return `amanha (${formatDateBr(dateStr).slice(0, 5)})`;
  return `${WEEKDAY_NAMES[weekdayOf(dateStr)]} (${formatDateBr(dateStr).slice(0, 5)})`;
}

function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(total) {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Faixas de atendimento do profissional na data (excecao de data tem prioridade). */
function rangesFor(professional, dateStr) {
  const exception = professional.exceptions ? professional.exceptions[dateStr] : undefined;
  if (Array.isArray(exception)) return exception;
  const weekly = professional.weekly || {};
  return weekly[String(weekdayOf(dateStr))] || weekly[weekdayOf(dateStr)] || [];
}

/**
 * Remove um intervalo das faixas de atendimento do dia.
 * Bloquear das 14h às 16h numa tarde de 13h–18h deixa 13h–14h e 16h–18h —
 * é assim que um congresso ou uma reunião entram na agenda sem fechar o dia.
 */
function subtrairFaixa(faixas, bloqueio) {
  const ini = toMinutes(bloqueio.start);
  const fim = toMinutes(bloqueio.end);
  const resultado = [];

  for (const faixa of faixas) {
    const a = toMinutes(faixa.start);
    const b = toMinutes(faixa.end);
    if (fim <= a || ini >= b) { resultado.push(faixa); continue; } // não se tocam
    if (ini > a) resultado.push({ start: faixa.start, end: fromMinutes(ini) });
    if (fim < b) resultado.push({ start: fromMinutes(fim), end: faixa.end });
  }
  return resultado;
}

class Agenda {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    // Preenchido pelo app: chamado quando um horário volta para a agenda.
    this.onSlotFreed = null;
  }

  get clinic() {
    return this.store.clinic;
  }

  get timezone() {
    return this.config.timezone;
  }

  today() {
    return dateKey(new Date(), this.timezone);
  }

  now() {
    return timeKey(new Date(), this.timezone);
  }

  /** O consultorio esta dentro do horario de funcionamento agora? */
  isOpenNow(when = new Date()) {
    const dia = dateKey(when, this.timezone);
    const agora = toMinutes(timeKey(when, this.timezone));
    return this.clinic.professionals.some((p) => rangesFor(p, dia)
      .some((r) => agora >= toMinutes(r.start) && agora < toMinutes(r.end)));
  }

  professionalsFor(serviceId) {
    // Todos atendem todos os servicos por padrao; profissionais podem restringir com `services`.
    return this.clinic.professionals.filter(
      (p) => !Array.isArray(p.services) || !serviceId || p.services.includes(serviceId),
    );
  }

  /** Intervalos ja ocupados (em minutos) do profissional na data. */
  busyIntervals(dateStr, professionalId) {
    const consultas = this.store.state.bookings
      .filter((b) => b.date === dateStr && b.professionalId === professionalId && b.status === 'confirmado')
      .map((b) => [toMinutes(b.start), toMinutes(b.end)]);
    // Compromissos vindos de fora (hoje, o Google Agenda do médico). Sem eles
    // o bot ofereceria ao paciente o horário do congresso que o médico marcou
    // no celular.
    const externos = this.ocupadosExternos
      ? this.ocupadosExternos(dateStr, professionalId) : [];
    return consultas.concat(externos.map((f) => [toMinutes(f.start), toMinutes(f.end)]));
  }

  /**
   * Horarios livres para um servico com um profissional.
   * A grade anda de `slotMinutes` em `slotMinutes` e o horario so entra
   * se a duracao inteira do atendimento couber livre na faixa.
   */
  slotsFor(dateStr, { professionalId, serviceId, includePast = false, now = new Date() } = {}) {
    const professional = findProfessional(this.clinic, professionalId) || this.clinic.professionals[0];
    if (!professional) return [];
    const service = findService(this.clinic, serviceId);
    const duracao = service ? service.durationMin : professional.slotMinutes || 30;
    // A cadencia acompanha a duracao do atendimento: evita oferecer horarios
    // sobrepostos ao paciente e mantem a agenda do dia sem buracos.
    const passo = duracao;
    const ocupados = this.busyIntervals(dateStr, professional.id);

    const slots = [];
    for (const range of rangesFor(professional, dateStr)) {
      const fim = toMinutes(range.end);
      for (let inicio = toMinutes(range.start); inicio + duracao <= fim; inicio += passo) {
        const conflita = ocupados.some(([a, b]) => inicio < b && inicio + duracao > a);
        if (conflita) continue;
        const startStr = fromMinutes(inicio);
        const startsAt = zonedToUtc(dateStr, startStr, this.timezone);
        if (!includePast && startsAt.getTime() <= now.getTime()) continue;
        slots.push({
          date: dateStr,
          start: startStr,
          end: fromMinutes(inicio + duracao),
          professionalId: professional.id,
          professionalName: professional.name,
          serviceId: service ? service.id : null,
          startsAt: startsAt.toISOString(),
        });
      }
    }
    return slots;
  }

  /** Proximos dias com pelo menos um horario livre. */
  nextAvailableDays(limit = 5, options = {}, searchDays = 45) {
    const dias = [];
    let cursor = this.today();
    for (let i = 0; i < searchDays && dias.length < limit; i += 1) {
      const slots = this.slotsFor(cursor, options);
      if (slots.length) dias.push({ date: cursor, slots });
      cursor = addDaysToKey(cursor, 1);
    }
    return dias;
  }

  /**
   * Quanto da agenda dos próximos dias já está tomado.
   *
   * Serve para o bot só falar em "datas enchendo" quando for verdade: escassez
   * inventada é percebida na semana seguinte, quando a vaga que ia acabar
   * continua lá — e aí nenhuma mensagem do consultório é levada a sério.
   */
  ocupacao(dias = 7, now = new Date()) {
    let livres = 0;
    let ocupados = 0;
    let cursor = dateKey(now, this.timezone);

    for (let i = 0; i < dias; i += 1) {
      for (const profissional of this.clinic.professionals) {
        const grade = this.slotsFor(cursor, {
          professionalId: profissional.id, includePast: true, now,
        }).length;
        const reservados = this.store.state.bookings.filter(
          (b) => b.date === cursor && b.professionalId === profissional.id && b.status === 'confirmado',
        ).length;
        livres += grade;
        ocupados += reservados;
      }
      cursor = addDaysToKey(cursor, 1);
    }

    const total = livres + ocupados;
    return {
      dias,
      total,
      ocupados,
      livres,
      percentual: total ? Math.round((ocupados / total) * 100) : 0,
    };
  }

  /**
   * Sete dias lado a lado, por profissional.
   *
   * "Hoje" resolve o dia; a lista de próximas consultas resolve o paciente.
   * Nenhuma das duas responde a pergunta que a recepção faz o tempo todo ao
   * telefone: onde é que tem buraco nesta semana. Aqui cada dia traz o que
   * está marcado, quantos horários sobraram e se o dia foi bloqueado — dá
   * para bater o olho e responder.
   */
  semana(inicio = this.today(), dias = 7) {
    const out = [];
    let cursor = inicio;
    for (let i = 0; i < dias; i += 1) {
      const profissionais = this.clinic.professionals.map((p) => {
        const marcadas = this.store.state.bookings
          .filter((b) => b.date === cursor && b.professionalId === p.id && b.status === 'confirmado')
          .sort((a, b) => a.start.localeCompare(b.start));
        const livres = this.slotsFor(cursor, {
          professionalId: p.id, includePast: true,
        }).length;
        const faixas = rangesFor(p, cursor);
        return {
          id: p.id,
          name: p.name,
          marcadas,
          livres,
          // Sem faixa nenhuma o dia não é "cheio", é fechado: férias, folga da
          // semana ou bloqueio. A tela precisa distinguir para não parecer que
          // a agenda lotou.
          atende: faixas.length > 0,
        };
      });
      out.push({
        date: cursor,
        weekday: weekdayOf(cursor),
        marcadas: profissionais.reduce((t, p) => t + p.marcadas.length, 0),
        livres: profissionais.reduce((t, p) => t + p.livres, 0),
        atende: profissionais.some((p) => p.atende),
        profissionais,
      });
      cursor = addDaysToKey(cursor, 1);
    }
    return out;
  }

  /** Segunda-feira da semana que contém a data (a semana da recepção começa aí). */
  segundaDe(dateStr = this.today()) {
    const dia = weekdayOf(dateStr);
    return addDaysToKey(dateStr, dia === 0 ? -6 : 1 - dia);
  }

  /** Agenda do dia por profissional — usado pelo painel da secretaria. */
  dayView(dateStr) {
    return this.clinic.professionals.map((p) => ({
      professional: { id: p.id, name: p.name, specialty: p.specialty },
      bookings: this.store.state.bookings
        .filter((b) => b.date === dateStr && b.professionalId === p.id && b.status === 'confirmado')
        .sort((a, b) => a.start.localeCompare(b.start)),
      freeSlots: this.slotsFor(dateStr, { professionalId: p.id, includePast: true }).length,
    }));
  }

  isSlotFree(dateStr, startStr, { professionalId, serviceId }) {
    return this.slotsFor(dateStr, { professionalId, serviceId, includePast: true })
      .some((s) => s.start === startStr);
  }

  book(contactId, { professionalId, serviceId, date, start, insurance = null, note = '' }) {
    if (!this.isSlotFree(date, start, { professionalId, serviceId })) {
      throw new Error('Horario indisponivel');
    }
    const service = findService(this.clinic, serviceId);
    const professional = findProfessional(this.clinic, professionalId) || this.clinic.professionals[0];
    return this.store.addBooking({
      contactId,
      professionalId: professional.id,
      professionalName: professional.name,
      serviceId: service ? service.id : null,
      serviceName: service ? service.name : 'Consulta',
      date,
      start,
      end: fromMinutes(toMinutes(start) + (service ? service.durationMin : professional.slotMinutes)),
      startsAt: zonedToUtc(date, start, this.timezone).toISOString(),
      insurance,
      note,
    });
  }

  cancel(bookingId, motivo = null) {
    const booking = this.store.getBooking(bookingId);
    if (!booking || booking.status !== 'confirmado') return null;
    booking.status = 'cancelado';
    booking.confirmation = 'cancelado';
    booking.cancelledAt = new Date().toISOString();
    if (motivo) booking.cancelReason = motivo;
    this.store.cancelReminders((r) => r.bookingId === bookingId);
    this.store.commit('booking', booking);
    if (this.onSlotFreed) this.onSlotFreed(booking);
    return booking;
  }

  /** Proxima consulta futura e confirmada do paciente. */
  nextBookingOf(contactId, now = new Date()) {
    return this.store.bookingsOf(contactId)
      .filter((b) => b.status === 'confirmado' && new Date(b.startsAt).getTime() >= now.getTime())
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0] || null;
  }
}

module.exports = {
  Agenda,
  WEEKDAY_NAMES,
  tzOffsetMs,
  zonedToUtc,
  dateKey,
  timeKey,
  weekdayOf,
  addDaysToKey,
  formatDateBr,
  formatDateLong,
  formatDateFriendly,
  toMinutes,
  fromMinutes,
  rangesFor,
  subtrairFaixa,
};
