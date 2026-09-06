'use strict';

const state = {
  data: null,
  selected: localStorage.getItem('pacienteSelecionado') || null,
  filtro: '',
  grupo: localStorage.getItem('grupoPacientes') || 'todos',
  tab: 'hoje',
  selecionados: new Set(),   // números escolhidos para o disparo
  segmento: null,            // segmento que preencheu a seleção
  rascunho: localStorage.getItem('rascunhoDisparo') || '',
  encaixe: {},              // profissional/atendimento escolhidos para encaixe manual
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function toast(msg) {
  const node = $('#toast');
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2800);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options && options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    mostrarLogin();
    const erro = new Error(data.error || 'Faça login para continuar');
    erro.semSessao = true;
    throw erro;
  }
  if (!res.ok) throw new Error(data.error || 'Falha na requisição');
  return data;
}

// ---------- acesso ----------

function mostrarLogin(mensagem) {
  const tela = $('#loginScreen');
  tela.hidden = false;
  const erro = $('#loginError');
  erro.hidden = !mensagem;
  erro.textContent = mensagem || '';
  const campo = $('#loginUser');
  if (campo && !campo.value) campo.focus();
}

function esconderLogin() {
  $('#loginScreen').hidden = true;
  $('#loginPass').value = '';
  $('#loginError').hidden = true;
}

async function entrar(e) {
  e.preventDefault();
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  if (!username || !password) return mostrarLogin('Preencha usuário e senha.');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return mostrarLogin(data.error || 'Não consegui entrar.');
    esconderLogin();
    await carregar();
    return undefined;
  } catch {
    return mostrarLogin('Não consegui falar com o servidor.');
  }
}

async function sair() {
  await fetch('/api/logout', { method: 'POST' });
  state.data = null;
  mostrarLogin();
}

// ---------- formatação ----------

const fmtHora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDia = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const fmtDataHora = (iso) => `${fmtDia(iso)} ${fmtHora(iso)}`;
const diaSemana = (data) => new Date(`${data}T12:00:00`)
  .toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });

function fmtRelativo(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const dias = Math.round(diff / 86400000);
  const horas = Math.round(diff / 3600000);
  if (Math.abs(horas) < 1) return diff >= 0 ? 'em minutos' : 'agora há pouco';
  if (Math.abs(dias) < 1) return diff >= 0 ? `em ${horas}h` : `há ${-horas}h`;
  return diff >= 0 ? `em ${dias} dia(s)` : `há ${-dias} dia(s)`;
}

const escapeHtml = (str) => String(str)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Converte a formatação do WhatsApp (*negrito*, _itálico_) em HTML seguro. */
function formatBody(body) {
  return escapeHtml(body)
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

/** Como a confirmação do paciente aparece na agenda da recepção. */
function selo(booking) {
  if (!booking) return { classe: '', texto: '—' };
  if (booking.confirmation === 'confirmado') return { classe: 'confirmado', texto: 'confirmado' };
  if (booking.confirmation === 'recusado') return { classe: 'urgente', texto: 'não vem' };
  return { classe: 'aguardando', texto: 'a confirmar' };
}

const pacientePorId = (id) => (state.data.contacts || []).find((c) => c.id === id) || null;
const nomePaciente = (c) => (c ? c.name || c.phone : 'Paciente');

// ---------- render ----------

function render() {
  const d = state.data;
  if (!d) return;

  $('#clinicName').textContent = d.clinic.name;
  $('#clinicSub').textContent = `${d.clinic.specialty} · assistente ${d.clinic.assistantName} · ${d.clinic.hoursText}`;

  const aberto = $('#openStatus');
  aberto.classList.toggle('online', d.aberto);
  aberto.querySelector('.label').textContent = d.aberto ? 'Atendendo agora' : 'Fora do horário';

  const canal = $('#channelStatus');
  canal.classList.toggle('online', d.channel.status === 'conectado');
  canal.querySelector('.label').textContent = d.channel.name === 'mock'
    ? 'Simulador ativo'
    : `WhatsApp: ${d.channel.status}`;

  renderKpis();
  renderFiltros();
  renderSelecao();
  renderContacts();
  renderChat();
  renderHoje();
  renderAgenda();
  renderReminders();
  renderDisparo();
  renderNumeros();
  renderActivity();
  renderMensagens();
  renderEquipe();
  renderConfig();
}

function renderKpis() {
  const d = state.data;
  const hojeConsultas = d.bookings.filter((b) => b.date === d.hoje && b.status === 'confirmado');
  const pendentes = d.reminders.filter((r) => r.status === 'pending');
  const futuras = d.bookings.filter((b) => b.status === 'confirmado' && new Date(b.startsAt) >= new Date());
  const aguardando = futuras.filter((b) => b.confirmation === 'aguardando' || b.confirmation === 'pedido');
  const recusadas = futuras.filter((b) => b.confirmation === 'recusado');
  const urgentes = d.contacts.filter((c) => c.priority === 'urgente');
  const humanos = d.contacts.filter((c) => c.stage === 'atendimento humano');

  const falta = d.metrics ? d.metrics.geral : null;
  const kpis = [
    ['Consultas hoje', hojeConsultas.length, ''],
    ['Taxa de falta (30d)', falta && falta.registradas ? `${falta.taxaFalta}%` : '—',
      falta && falta.taxaFalta >= 20 ? 'danger' : falta && falta.taxaFalta >= 10 ? 'warn' : ''],
    ['Aguardando confirmação', aguardando.length, aguardando.length ? 'warn' : ''],
    ['Avisaram que não vêm', recusadas.length, recusadas.length ? 'danger' : ''],
    ['Na fila da recepção', humanos.length, humanos.length ? 'warn' : ''],
    ['Urgências', urgentes.length, urgentes.length ? 'danger' : ''],
    ['Na lista de espera', (d.waitlist || []).length, ''],
    ['Pacientes', d.contacts.length, ''],
    ['Lembretes pendentes', pendentes.length, ''],
  ];
  const box = $('#kpis');
  box.innerHTML = '';
  for (const [label, value, tom] of kpis) {
    const card = el('div', `kpi ${tom}`);
    card.append(el('div', 'value', String(value)), el('div', 'label', label));
    box.append(card);
  }
}

const GRUPOS = [
  ['todos', 'Todos'],
  ['fila', 'Na fila'],
  ['urgente', 'Urgentes'],
  ['agendado', 'Agendados'],
  ['sem-consulta', 'Sem consulta'],
];

function renderFiltros() {
  const box = $('#filters');
  box.innerHTML = '';
  for (const [id, label] of GRUPOS) {
    const btn = el('button', state.grupo === id ? 'active' : '', label);
    btn.addEventListener('click', () => {
      state.grupo = id;
      localStorage.setItem('grupoPacientes', id);
      renderFiltros();
      renderContacts();
    });
    box.append(btn);
  }
}

function passaNoGrupo(c) {
  if (state.grupo === 'fila') return c.stage === 'atendimento humano';
  if (state.grupo === 'urgente') return c.priority === 'urgente' || c.priority === 'atencao';
  if (state.grupo === 'agendado') return !!c.nextBooking;
  if (state.grupo === 'sem-consulta') return !c.nextBooking && !c.optOut;
  return true;
}

function renderContacts() {
  const list = $('#contactList');
  list.innerHTML = '';
  const filtro = state.filtro.toLowerCase();
  const pacientes = state.data.contacts
    .filter(passaNoGrupo)
    .filter((c) => !filtro || (c.name || '').toLowerCase().includes(filtro) || c.phone.includes(filtro))
    .sort((a, b) => {
      const urgencia = (c) => (c.priority === 'urgente' ? 0 : c.stage === 'atendimento humano' ? 1 : 2);
      if (urgencia(a) !== urgencia(b)) return urgencia(a) - urgencia(b);
      return new Date(b.lastMessage ? b.lastMessage.at : b.createdAt)
        - new Date(a.lastMessage ? a.lastMessage.at : a.createdAt);
    });

  if (!pacientes.length) {
    list.append(el('div', 'empty', 'Nenhum paciente neste filtro.'));
    return;
  }

  for (const c of pacientes) {
    const li = el('li');
    if (c.id === state.selected) li.classList.add('active');

    const pick = el('input', 'pick');
    pick.type = 'checkbox';
    pick.checked = state.selecionados.has(c.id);
    pick.title = c.optOut ? 'Pediu para não receber mensagens' : 'Selecionar para disparo';
    pick.disabled = !!c.optOut;
    pick.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pick.checked) state.selecionados.add(c.id);
      else state.selecionados.delete(c.id);
      state.segmento = null;
      renderSelecao();
      renderDisparo();
    });
    li.append(pick);

    const row = el('div', 'contact-row');
    row.append(el('span', 'contact-name', nomePaciente(c)));
    if (c.priority === 'urgente') row.append(el('span', 'badge urgente', 'urgente'));
    else if (c.stage === 'atendimento humano') row.append(el('span', 'badge atencao', 'na fila'));
    else row.append(el('span', `badge ${c.stage.replace(/\s+/g, '-')}`, c.stage));
    li.append(row);

    const row2 = el('div', 'contact-row');
    row2.append(el('span', 'contact-last', c.lastMessage
      ? `${c.lastMessage.direction === 'out' ? '↩ ' : ''}${c.lastMessage.body.slice(0, 36)}`
      : c.phone));
    if (c.lastMessage) row2.append(el('span', 'time', fmtDataHora(c.lastMessage.at)));
    li.append(row2);

    if (c.nextBooking) {
      li.append(el('div', 'contact-last',
        `📅 ${fmtDia(c.nextBooking.startsAt)} ${c.nextBooking.start} · ${c.nextBooking.professionalName}`));
    }

    li.addEventListener('click', () => {
      state.selected = c.id;
      localStorage.setItem('pacienteSelecionado', c.id);
      render();
    });
    list.append(li);
  }
}

function renderChat() {
  const box = $('#messages');
  const card = $('#patientCard');
  const paciente = pacientePorId(state.selected);
  box.innerHTML = '';
  card.innerHTML = '';
  card.classList.toggle('show', !!paciente);

  if (!paciente) {
    $('#chatName').textContent = 'Selecione um paciente';
    $('#chatMeta').textContent = 'O simulador permite testar o atendimento sem conectar o WhatsApp';
    box.append(el('div', 'empty', 'Escolha um paciente à esquerda para ver a conversa.'));
    renderQuickReplies();
    return;
  }

  $('#chatName').textContent = nomePaciente(paciente);
  $('#chatMeta').textContent = `${paciente.phone} · etapa: ${paciente.state.step}`;

  const dados = [
    ['Nascimento', paciente.birthDate || '—'],
    ['Convênio', paciente.insurance || '—'],
    ['Próxima consulta', paciente.nextBooking
      ? `${fmtDia(paciente.nextBooking.startsAt)} ${paciente.nextBooking.start} · ${paciente.nextBooking.serviceName}`
      : '—'],
    ['Confirmação', selo(paciente.nextBooking).texto],
  ];
  for (const [label, valor] of dados) {
    const item = el('span');
    item.append(document.createTextNode(`${label}: `), el('b', null, valor));
    card.append(item);
  }
  if (paciente.notes && paciente.notes.length) {
    card.append(el('span', null, `📝 ${paciente.notes[paciente.notes.length - 1].text}`));
  }

  const msgs = state.data.messages.filter((m) => m.contactId === paciente.id);
  if (!msgs.length) box.append(el('div', 'empty', 'Sem mensagens. Envie "oi" pelo simulador.'));

  let ultimoDia = null;
  for (const m of msgs) {
    const dia = new Date(m.at).toLocaleDateString('pt-BR');
    if (dia !== ultimoDia) {
      box.append(el('div', 'day-sep', dia));
      ultimoDia = dia;
    }
    const bubble = el('div', `bubble ${m.direction}`);
    const midia = m.meta && m.meta.mediaType;
    if (midia) {
      bubble.classList.add('media');
      bubble.append(el('span', 'media-tag', `${ICONE_MIDIA[midia] || '📎'} ${midia} recebido`));
      if (m.body && !m.body.startsWith('[')) bubble.append(el('div', null, m.body));
    } else {
      bubble.innerHTML = formatBody(m.body);
    }
    bubble.append(el('span', 'meta', fmtHora(m.at)));
    box.append(bubble);
  }
  box.scrollTop = box.scrollHeight;
  renderQuickReplies();
}

const ICONE_MIDIA = {
  audio: '🎤', imagem: '📷', video: '🎬', documento: '📄',
  figurinha: '🙂', localizacao: '📍', contato: '👤', anexo: '📎',
};

/** Mídia que dá para simular no painel, para testar o caminho sem WhatsApp. */
const ATALHOS_MIDIA = [['audio', '🎤 Áudio'], ['imagem', '📷 Foto']];

const ATALHOS = [
  'Oi', 'Quanto custa a consulta?', 'Quero marcar uma consulta', 'É primeira consulta',
  'Unimed', 'Particular', 'Tanto faz', 'Sim', 'Não', 'Preciso remarcar',
  'Vocês atendem meu plano?', 'Onde fica?', 'Quero falar com a secretária',
  'Estou com dor no peito',
];

function renderQuickReplies() {
  const box = $('#quickReplies');
  box.innerHTML = '';
  if (!state.selected) return;
  for (const texto of ATALHOS) {
    const btn = el('button', null, texto);
    btn.addEventListener('click', () => enviar('in', texto));
    box.append(btn);
  }
  for (const [tipo, rotulo] of ATALHOS_MIDIA) {
    const btn = el('button', null, rotulo);
    btn.title = 'Simula o paciente mandando esse tipo de mensagem';
    btn.addEventListener('click', () => enviarMidia(tipo));
    box.append(btn);
  }
}

/** Aba Hoje: a agenda do dia por profissional, com confirmação e presença. */
function renderHoje() {
  const panel = $('#tab-hoje');
  panel.innerHTML = '';
  const d = state.data;

  panel.append(el('div', 'day-title cap', diaSemana(d.hoje)));

  for (const bloco of d.dayView) {
    const box = el('div', 'prof-block');
    const head = el('div', 'prof-head');
    head.append(el('span', 'name', bloco.professional.name));
    head.append(el('span', 'spec', `${bloco.bookings.length} consulta(s)`));
    box.append(head);

    if (!bloco.bookings.length) box.append(el('div', 'empty', 'Sem consultas hoje.'));

    for (const b of bloco.bookings) {
      const paciente = pacientePorId(b.contactId);
      const item = el('div', `appt ${b.attendance ? 'done' : ''}`);

      const linha = el('div', 'row');
      linha.append(el('span', 'hour', b.start));
      const marca = selo(b);
      linha.append(el('span', `badge ${marca.classe}`, marca.texto));
      item.append(linha);
      item.append(el('div', 'who', `${nomePaciente(paciente)} · ${b.serviceName} · ${b.insurance || 'Particular'}`));

      const acoes = el('div', 'actions');
      if (b.confirmation !== 'confirmado') {
        acoes.append(botao('Confirmar', () => statusConsulta(b.id, { confirmation: 'confirmado' })));
      }
      if (!b.attendance) {
        acoes.append(botao('Compareceu', () => statusConsulta(b.id, { attendance: 'compareceu' })));
        acoes.append(botao('Faltou', () => statusConsulta(b.id, { attendance: 'faltou' })));
      } else {
        acoes.append(el('span', 'desc', b.attendance === 'compareceu' ? '✅ compareceu' : '⚠️ faltou'));
      }
      acoes.append(botao('Cancelar', async () => {
        await api(`/api/bookings/${b.id}`, { method: 'DELETE' });
        toast('Consulta cancelada');
        await carregar();
      }));
      item.append(acoes);
      box.append(item);
    }
    panel.append(box);
  }
}

/** Lista de espera: quem é chamado quando um horário volta para a agenda. */
function renderEspera(panel, d, paciente) {
  const fila = d.waitlist || [];
  panel.append(el('div', 'day-title', `Lista de espera (${fila.length})`));

  if (!fila.length) {
    panel.append(el('div', 'desc',
      'Ninguém esperando. Quando não há horário livre, o bot oferece a fila ao paciente.'));
  }

  for (const entrada of fila) {
    const contato = pacientePorId(entrada.contactId);
    const item = el('div', 'item');
    const row = el('div', 'row');
    row.append(el('span', 'title', `${entrada.posicao}º · ${nomePaciente(contato)}`));
    row.append(el('span', `badge ${entrada.status === 'oferecido' ? 'aguardando' : ''}`,
      entrada.status === 'oferecido' ? 'vaga oferecida' : 'esperando'));
    item.append(row);

    if (entrada.status === 'oferecido' && entrada.offer) {
      item.append(el('div', 'desc',
        `${fmtDia(`${entrada.offer.date}T12:00:00`)} às ${entrada.offer.start}`
        + ` · responde até ${fmtHora(entrada.offer.expiresAt)}`));
    } else {
      item.append(el('div', 'desc', `na fila desde ${fmtDataHora(entrada.createdAt)}`));
    }

    const acoes = el('div', 'actions');
    acoes.append(botao('Remover', async () => {
      await api(`/api/waitlist/${entrada.id}`, { method: 'DELETE' });
      toast('Nome retirado da lista');
      await carregar();
    }));
    item.append(acoes);
    panel.append(item);
  }

  if (paciente && !fila.some((e) => e.contactId === paciente.id)) {
    const adicionar = el('button', 'ghost', `+ Colocar ${nomePaciente(paciente)} na espera`);
    adicionar.addEventListener('click', async () => {
      await api('/api/waitlist', { method: 'POST', body: { contactId: paciente.id } });
      toast('Paciente na lista de espera');
      await carregar();
    });
    panel.append(adicionar);
  }

  panel.append(el('hr'));
}

function botao(texto, acao) {
  const btn = el('button', 'ghost', texto);
  btn.addEventListener('click', acao);
  return btn;
}

async function statusConsulta(id, body) {
  await api(`/api/bookings/${id}/status`, { method: 'POST', body });
  toast('Consulta atualizada');
  await carregar();
}

/** Aba Agenda: lista de espera, próximas consultas e horários livres. */
function renderAgenda() {
  const panel = $('#tab-agenda');
  panel.innerHTML = '';
  const d = state.data;
  const paciente = pacientePorId(state.selected);

  renderEspera(panel, d, paciente);

  const futuras = d.bookings
    .filter((b) => b.status === 'confirmado' && new Date(b.startsAt) >= new Date())
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));

  panel.append(el('div', 'day-title', `Próximas consultas (${futuras.length})`));
  if (!futuras.length) panel.append(el('div', 'empty', 'Nenhuma consulta marcada.'));
  for (const b of futuras.slice(0, 12)) {
    const item = el('div', 'item');
    const row = el('div', 'row');
    row.append(el('span', 'title', `${fmtDia(b.startsAt)} · ${b.start}`));
    const marca = selo(b);
    row.append(el('span', `badge ${marca.classe}`, marca.texto));
    item.append(row);
    item.append(el('div', 'desc',
      `${nomePaciente(pacientePorId(b.contactId))} · ${b.serviceName} · ${b.professionalName}`));
    panel.append(item);
  }

  panel.append(el('hr'));
  panel.append(el('div', 'day-title', paciente
    ? `Encaixar ${nomePaciente(paciente)}`
    : 'Horários livres (selecione um paciente para encaixar)'));

  // Quem atende e o que é o atendimento mudam a grade — por isso a escolha
  // vem antes dos horários, e não fixa no primeiro cadastrado.
  const escolha = el('div', 'send-row');
  const profSelect = el('select');
  for (const p of d.clinic.professionals) {
    const op = el('option', null, p.name);
    op.value = p.id;
    profSelect.append(op);
  }
  profSelect.value = state.encaixe.professionalId || d.clinic.professionals[0].id;

  const servSelect = el('select');
  for (const sv of d.clinic.services) {
    const op = el('option', null, `${sv.name} (${sv.durationMin} min)`);
    op.value = sv.id;
    servSelect.append(op);
  }
  servSelect.value = state.encaixe.serviceId || d.clinic.services[0].id;

  const aoTrocar = async () => {
    state.encaixe = { professionalId: profSelect.value, serviceId: servSelect.value };
    const dados = await api(`/api/slots-dias?professionalId=${profSelect.value}&serviceId=${servSelect.value}`);
    state.encaixe.dias = dados.dias;
    renderAgenda();
  };
  profSelect.addEventListener('change', aoTrocar);
  servSelect.addEventListener('change', aoTrocar);
  escolha.append(profSelect, servSelect);
  panel.append(escolha);

  const dias = state.encaixe.dias || d.agendaDays;
  for (const dia of dias) {
    const bloco = el('div', 'day-block');
    bloco.append(el('div', 'day-title cap', diaSemana(dia.date)));
    const slots = el('div', 'slots');
    for (const sl of dia.slots) {
      const btn = el('button', 'slot', sl.start);
      btn.addEventListener('click', async () => {
        if (!paciente) return toast('Selecione um paciente primeiro');
        try {
          await api('/api/bookings', {
            method: 'POST',
            body: {
              contactId: paciente.id,
              professionalId: profSelect.value,
              serviceId: servSelect.value,
              date: dia.date,
              start: sl.start,
              insurance: paciente.insurance,
            },
          });
          toast(`Encaixado ${sl.start} em ${dia.date}`);
          state.encaixe.dias = null;
          await carregar();
        } catch (err) { toast(err.message); }
        return undefined;
      });
      slots.append(btn);
    }
    bloco.append(slots);
    panel.append(bloco);
  }

  if (!dias.length) {
    panel.append(el('div', 'empty',
      'Sem horários livres para essa combinação. Ajuste a agenda em Equipe.'));
  }
}

const ROTULO_LEMBRETE = {
  followup: '🔔 follow-up',
  booking: '📅 antes da consulta',
  retorno: '🔁 retorno',
  falta: '⚠️ falta',
};

function renderReminders() {
  const panel = $('#tab-lembretes');
  panel.innerHTML = '';
  const d = state.data;

  panel.append(el('div', 'desc',
    `Follow-up ${d.offsets.followUp.join('/')} dias após o contato · `
    + `${d.offsets.booking.join('/')} dias antes da consulta · retorno conforme o tipo de atendimento`));

  const pendentes = d.reminders
    .filter((r) => r.status === 'pending')
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

  panel.append(el('div', 'day-title', `Programados (${pendentes.length})`));
  if (!pendentes.length) panel.append(el('div', 'empty', 'Nenhum lembrete programado.'));

  for (const r of pendentes.slice(0, 40)) {
    const item = el('div', 'item');
    const row = el('div', 'row');
    row.append(el('span', 'title', `${ROTULO_LEMBRETE[r.kind] || r.kind} · ${nomePaciente(pacientePorId(r.contactId))}`));
    row.append(el('span', 'time', fmtRelativo(r.dueAt)));
    item.append(row);
    item.append(el('div', 'desc', `${r.offsetDays} dia(s) · ${fmtDataHora(r.dueAt)}`));

    const actions = el('div', 'actions');
    actions.append(botao('Enviar agora', async () => {
      await api(`/api/reminders/${r.id}/send`, { method: 'POST' });
      toast('Lembrete enviado');
      await carregar();
    }));
    actions.append(botao('Cancelar', async () => {
      await api(`/api/reminders/${r.id}`, { method: 'DELETE' });
      await carregar();
    }));
    item.append(actions);
    panel.append(item);
  }

  const enviados = d.reminders.filter((r) => r.status === 'enviado').slice(-8).reverse();
  if (enviados.length) {
    panel.append(el('div', 'day-title', 'Enviados recentemente'));
    for (const r of enviados) {
      const item = el('div', 'item');
      item.append(el('div', 'title', `✅ ${ROTULO_LEMBRETE[r.kind] || r.kind} · ${nomePaciente(pacientePorId(r.contactId))}`));
      item.append(el('div', 'desc', fmtDataHora(r.sentAt)));
      panel.append(item);
    }
  }
}

/** Barra que aparece quando há números escolhidos. */
function renderSelecao() {
  const bar = $('#selectionBar');
  bar.innerHTML = '';
  const total = state.selecionados.size;
  bar.classList.toggle('show', total > 0);
  if (!total) return;

  bar.append(el('span', 'count', `${total} selecionado(s)`));
  bar.append(botao('Selecionar filtro', () => {
    for (const c of pacientesDoFiltro()) if (!c.optOut) state.selecionados.add(c.id);
    state.segmento = null;
    renderSelecao(); renderContacts(); renderDisparo();
  }));
  bar.append(botao('Copiar números', () => copiarNumeros()));
  bar.append(botao('Limpar', () => {
    state.selecionados.clear();
    state.segmento = null;
    renderSelecao(); renderContacts(); renderDisparo();
  }));
  bar.append(botao('Ir para o disparo', () => abrirAba('disparo')));
}

function pacientesDoFiltro() {
  const filtro = state.filtro.toLowerCase();
  return state.data.contacts
    .filter(passaNoGrupo)
    .filter((c) => !filtro || (c.name || '').toLowerCase().includes(filtro) || c.phone.includes(filtro));
}

function selecionadosDetalhe() {
  return [...state.selecionados].map(pacientePorId).filter(Boolean);
}

async function copiarNumeros() {
  const numeros = selecionadosDetalhe().map((c) => c.phone).join('\n');
  try {
    await navigator.clipboard.writeText(numeros);
    toast(`${state.selecionados.size} número(s) copiados`);
  } catch {
    prompt('Copie os números:', numeros.replace(/\n/g, ', '));
  }
}

function baixarCsv() {
  const linhas = [['nome', 'telefone', 'convenio', 'situacao', 'proxima_consulta']];
  for (const c of selecionadosDetalhe()) {
    linhas.push([
      c.name || '', c.phone, c.insurance || '', c.stage,
      c.nextBooking ? `${c.nextBooking.date} ${c.nextBooking.start}` : '',
    ]);
  }
  const csv = linhas.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = el('a');
  a.href = url;
  a.download = `pacientes-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function abrirAba(id) {
  const seletor = $('#tabSelect');
  if (!seletor) return;
  seletor.value = id;
  seletor.dispatchEvent(new Event('change'));
}

/** Aba Disparo: escolher o grupo, escrever a mensagem e enviar. */
function renderDisparo() {
  const panel = $('#tab-disparo');
  if (!panel) return;
  const foco = document.activeElement;
  const editando = foco && foco.id === 'msgDisparo';
  if (editando) state.rascunho = foco.value;
  panel.innerHTML = '';
  const d = state.data;

  // 1. segmentos prontos
  panel.append(el('div', 'day-title', '1. Quem vai receber'));
  const lista = el('div', 'seg-list');
  for (const seg of d.segments) {
    const btn = el('button', `seg ${state.segmento === seg.id ? 'active' : ''}`);
    const info = el('div');
    info.append(el('div', 'seg-label', seg.label));
    info.append(el('div', 'seg-desc', seg.descricao));
    btn.append(info);
    btn.append(el('span', 'seg-count', String(seg.total)));
    btn.addEventListener('click', () => carregarSegmento(seg.id));
    lista.append(btn);
  }
  panel.append(lista);
  panel.append(el('div', 'desc', 'Ou marque os pacientes um a um na lista à esquerda.'));

  const total = state.selecionados.size;
  const resumo = el('div', 'item');
  resumo.append(el('div', 'title', total
    ? `${total} paciente(s) selecionado(s)`
    : 'Nenhum paciente selecionado ainda'));
  if (total) {
    const nomes = selecionadosDetalhe().slice(0, 6).map((c) => c.name || c.phone).join(', ');
    resumo.append(el('div', 'desc', total > 6 ? `${nomes} e mais ${total - 6}…` : nomes));
    const acoes = el('div', 'actions');
    acoes.append(botao('Copiar números', copiarNumeros));
    acoes.append(botao('Baixar CSV', baixarCsv));
    acoes.append(botao('Limpar', () => {
      state.selecionados.clear();
      state.segmento = null;
      renderSelecao(); renderContacts(); renderDisparo();
    }));
    resumo.append(acoes);
  }
  panel.append(resumo);

  // 2. mensagem
  panel.append(el('div', 'day-title', '2. Sua mensagem'));
  const campoMsg = el('textarea');
  campoMsg.id = 'msgDisparo';
  campoMsg.rows = 5;
  campoMsg.placeholder = 'Ex.: Oi {primeiro_nome}! Abrimos horários extras nesta sexta. Quer que eu reserve um para você?';
  campoMsg.value = state.rascunho;
  campoMsg.addEventListener('input', () => {
    state.rascunho = campoMsg.value;
    localStorage.setItem('rascunhoDisparo', campoMsg.value);
    atualizarPrevia();
  });
  const box = el('div', 'field');
  box.append(campoMsg);
  panel.append(box);

  const vars = el('div', 'vars');
  for (const v of d.variables) {
    const btn = el('button', null, v);
    btn.title = 'Inserir no texto';
    btn.addEventListener('click', () => {
      const alvo = $('#msgDisparo');
      const pos = alvo.selectionStart || alvo.value.length;
      alvo.value = `${alvo.value.slice(0, pos)}${v}${alvo.value.slice(pos)}`;
      state.rascunho = alvo.value;
      localStorage.setItem('rascunhoDisparo', alvo.value);
      alvo.focus();
      alvo.setSelectionRange(pos + v.length, pos + v.length);
      atualizarPrevia();
    });
    vars.append(btn);
  }
  panel.append(vars);

  const previa = el('div', 'preview');
  previa.id = 'previaDisparo';
  previa.textContent = 'A prévia aparece aqui.';
  panel.append(previa);

  // 3. envio
  panel.append(el('div', 'day-title', '3. Enviar'));
  const linha = el('div', 'send-row');
  const quando = el('input');
  quando.type = 'datetime-local';
  quando.id = 'quandoDisparo';
  quando.title = 'Deixe vazio para enviar agora';
  linha.append(quando);
  const enviar = el('button', null, 'Disparar');
  enviar.addEventListener('click', dispararAgora);
  linha.append(enviar);
  panel.append(linha);

  const limites = d.broadcastLimits || {};
  panel.append(el('div', 'warn-note',
    `Envio espaçado em ${(limites.delayMs || 0) / 1000}s entre mensagens, limite de ${limites.max} por disparo. `
    + 'Quem respondeu "sair" nunca recebe. Mande só para quem já falou com o consultório e espera notícias suas — '
    + 'disparo para lista comprada derruba o número.'));

  // histórico
  if (d.campaigns && d.campaigns.length) {
    panel.append(el('div', 'day-title', 'Disparos recentes'));
    for (const c of d.campaigns) {
      const item = el('div', 'item');
      const row = el('div', 'row');
      row.append(el('span', 'title', `${c.sent}/${c.total} enviadas`));
      row.append(el('span', 'badge', c.status));
      item.append(row);
      item.append(el('div', 'desc', `${fmtDataHora(c.scheduledAt || c.createdAt)} · ${c.texto.slice(0, 70)}${c.texto.length > 70 ? '…' : ''}`));
      const barra = el('div', 'bar');
      const preenchido = el('i');
      preenchido.style.width = `${c.total ? Math.round((c.sent / c.total) * 100) : 0}%`;
      barra.append(preenchido);
      item.append(barra);
      if (c.status === 'agendado') {
        const acoes = el('div', 'actions');
        acoes.append(botao('Cancelar agendamento', async () => {
          await api(`/api/broadcast/${c.id}`, { method: 'DELETE' });
          toast('Disparo agendado cancelado');
          await carregar();
        }));
        item.append(acoes);
      }
      panel.append(item);
    }
  }

  atualizarPrevia();
  if (editando) {
    const novo = $('#msgDisparo');
    novo.focus();
    novo.setSelectionRange(novo.value.length, novo.value.length);
  }
}

async function carregarSegmento(id) {
  const dados = await api(`/api/segments/${id}`);
  state.selecionados = new Set(dados.contatos.filter((c) => !c.optOut).map((c) => c.id));
  state.segmento = id;
  toast(`${state.selecionados.size} paciente(s) selecionados`);
  renderSelecao();
  renderContacts();
  renderDisparo();
}

let previaTimer = null;
function atualizarPrevia() {
  clearTimeout(previaTimer);
  previaTimer = setTimeout(async () => {
    const alvo = $('#previaDisparo');
    if (!alvo) return;
    const texto = state.rascunho.trim();
    if (!texto || !state.selecionados.size) {
      alvo.textContent = 'Escolha os pacientes e escreva a mensagem para ver a prévia.';
      return;
    }
    try {
      const p = await api('/api/broadcast/preview', {
        method: 'POST',
        body: { contactIds: [...state.selecionados], body: texto },
      });
      alvo.innerHTML = '';
      alvo.append(el('div', 'who', `Prévia para ${p.exemplos.length} de ${p.total} destinatário(s)`
        + (p.ignorados.length ? ` · ${p.ignorados.length} fora (opt-out/repetido)` : '')));
      for (const ex of p.exemplos) {
        const bloco = el('div');
        bloco.append(el('div', 'who', `→ ${ex.nome} (${ex.phone})`));
        bloco.append(document.createTextNode(ex.texto));
        alvo.append(bloco);
      }
    } catch (err) {
      alvo.textContent = err.message;
    }
  }, 250);
}

async function dispararAgora() {
  const texto = state.rascunho.trim();
  const quando = $('#quandoDisparo').value;
  if (!state.selecionados.size) return toast('Selecione ao menos um paciente');
  if (!texto) return toast('Escreva a mensagem');

  const total = state.selecionados.size;
  const aviso = quando
    ? `Agendar o envio para ${total} paciente(s) em ${new Date(quando).toLocaleString('pt-BR')}?`
    : `Enviar agora para ${total} paciente(s)? Isso manda mensagem de verdade se o WhatsApp estiver conectado.`;
  if (!confirm(aviso)) return;

  try {
    await api('/api/broadcast', {
      method: 'POST',
      body: {
        contactIds: [...state.selecionados],
        body: texto,
        segmento: state.segmento,
        scheduledAt: quando ? new Date(quando).toISOString() : null,
      },
    });
    toast(quando ? 'Disparo agendado' : 'Disparo iniciado');
    state.rascunho = '';
    localStorage.removeItem('rascunhoDisparo');
    state.selecionados.clear();
    state.segmento = null;
    await carregar();
  } catch (err) {
    toast(err.message);
  }
}

/** Cor do número conforme a faixa: abaixo de 10% de falta é bom, acima de 20% acende. */
function tomDaFalta(taxa) {
  if (taxa >= 20) return 'ruim';
  if (taxa >= 10) return 'atencao';
  return 'bom';
}

function blocoMetrica(rotulo, valor, tom, detalhe) {
  const box = el('div', 'metric');
  box.append(el('div', 'cap', rotulo));
  box.append(el('div', `big ${tom || ''}`, valor));
  if (detalhe) box.append(el('div', 'sub2', detalhe));
  return box;
}

/** Aba Números: taxa de falta e o efeito da confirmação. */
function renderNumeros() {
  const panel = $('#tab-numeros');
  if (!panel) return;
  panel.innerHTML = '';
  const m = state.data.metrics;
  if (!m) return;

  panel.append(el('div', 'day-title', `Últimos ${m.dias} dias`));

  if (!m.geral.registradas) {
    panel.append(el('div', 'empty',
      'Ainda não há presença registrada. Marque "Compareceu" ou "Faltou" na aba Hoje '
      + 'e a taxa de falta aparece aqui.'));
    return;
  }

  panel.append(blocoMetrica(
    'Taxa de falta',
    `${m.geral.taxaFalta}%`,
    tomDaFalta(m.geral.taxaFalta),
    `${m.geral.faltaram} falta(s) em ${m.geral.registradas} consulta(s) com presença registrada`,
  ));

  if (m.geral.semRegistro) {
    panel.append(el('div', 'warn-note',
      `${m.geral.semRegistro} consulta(s) já passaram sem ninguém marcar presença. `
      + 'Elas ficam de fora da conta — a taxa vale o que vale o registro.'));
  }

  // O número que diz se o lembrete de véspera está pagando o próprio trabalho.
  panel.append(el('div', 'day-title', 'Confirmou × não confirmou'));
  const comparativo = el('div', 'compare');
  comparativo.append(blocoMetrica(
    'Confirmaram',
    `${m.confirmacao.confirmadas.taxaFalta}%`,
    tomDaFalta(m.confirmacao.confirmadas.taxaFalta),
    `${m.confirmacao.confirmadas.registradas} consulta(s)`,
  ));
  comparativo.append(blocoMetrica(
    'Não confirmaram',
    `${m.confirmacao.naoConfirmadas.taxaFalta}%`,
    tomDaFalta(m.confirmacao.naoConfirmadas.taxaFalta),
    `${m.confirmacao.naoConfirmadas.registradas} consulta(s)`,
  ));
  panel.append(comparativo);

  if (m.confirmacao.confirmadas.registradas && m.confirmacao.naoConfirmadas.registradas) {
    const dif = m.confirmacao.diferenca;
    panel.append(el('div', 'desc', dif > 0
      ? `Quem confirma falta ${dif} ponto(s) percentual(is) menos. O lembrete de véspera está funcionando.`
      : 'Ainda não dá para ver diferença entre quem confirma e quem não confirma.'));
  }

  if (m.porProfissional.length) {
    panel.append(el('div', 'day-title', 'Por profissional'));
    const box = el('div', 'item');
    for (const p of m.porProfissional) {
      const linha = el('div', 'mini-row');
      linha.append(el('span', null, p.name));
      const val = el('span', `val ${tomDaFalta(p.taxaFalta)}`,
        p.registradas ? `${p.taxaFalta}%` : '—');
      val.title = `${p.faltaram} falta(s) em ${p.registradas} registro(s)`;
      linha.append(val);
      box.append(linha);
    }
    panel.append(box);
  }

  const oc = state.data.ocupacao;
  if (oc && oc.total) {
    panel.append(el('div', 'day-title', 'Ocupação dos próximos 7 dias'));
    panel.append(blocoMetrica(
      'Agenda ocupada',
      `${oc.percentual}%`,
      oc.percentual >= 80 ? 'atencao' : 'bom',
      `${oc.ocupados} consulta(s) marcada(s) · ${oc.livres} horário(s) livre(s)`
      + (oc.percentual >= 80 ? ' — o bot já pode dizer que as datas estão fechando' : ''),
    ));
  }

  panel.append(el('div', 'day-title', 'Movimento'));
  const mov = el('div', 'item');
  for (const [rotulo, valor] of [
    ['Consultas no período', m.geral.total],
    ['Compareceram', m.geral.compareceram],
    ['Faltaram', m.geral.faltaram],
    ['Canceladas', m.canceladas],
  ]) {
    const linha = el('div', 'mini-row');
    linha.append(el('span', null, rotulo));
    linha.append(el('span', 'val', String(valor)));
    mov.append(linha);
  }
  panel.append(mov);
}

function renderActivity() {
  const panel = $('#tab-atividade');
  panel.innerHTML = '';
  const eventos = state.data.events;
  if (!eventos.length) {
    panel.append(el('div', 'empty', 'Sem atividade registrada ainda.'));
    return;
  }
  const ul = el('ul', 'timeline');
  for (const ev of eventos) {
    const li = el('li');
    li.append(el('span', 'time', fmtDataHora(ev.at)));
    li.append(document.createTextNode(ev.text));
    ul.append(li);
  }
  panel.append(ul);
}

/**
 * Aba Mensagens: reescrever o que o bot fala, sem mexer no código.
 * Campo vazio volta ao texto padrão — é o caminho de volta sempre disponível.
 */
function renderMensagens() {
  const panel = $('#tab-mensagens');
  if (!panel) return;

  const foco = document.activeElement;
  const digitando = foco && panel.contains(foco) && foco.tagName === 'TEXTAREA';
  if (panel.childElementCount && digitando) return;

  const campos = state.data.messageFields || [];
  const guardadas = state.data.clinic.messages || {};
  const assinatura = JSON.stringify(guardadas);
  if (!state.mensagens || state.mensagens.assinatura !== assinatura) {
    state.mensagens = { assinatura, valores: { ...guardadas } };
  }

  panel.innerHTML = '';
  panel.append(el('div', 'desc',
    'Deixe em branco para usar o texto padrão. As variáveis entre chaves são preenchidas '
    + 'na hora do envio — clique para inserir.'));

  const salvar = async () => {
    await api('/api/clinic', { method: 'PUT', body: { messages: state.mensagens.valores } });
    state.mensagens = null;
    toast('Mensagens atualizadas');
    await carregar();
  };

  for (const campo of campos) {
    const bloco = el('div', 'msg-block');
    const cabecalho = el('div', 'row');
    cabecalho.append(el('span', 'title', campo.titulo));
    const marca = el('span', 'badge', state.mensagens.valores[campo.id] ? 'personalizada' : 'padrão');
    cabecalho.append(marca);
    bloco.append(cabecalho);
    bloco.append(el('div', 'desc', campo.descricao));

    const area = el('textarea');
    area.rows = 4;
    area.placeholder = 'Usando o texto padrão do sistema…';
    area.value = state.mensagens.valores[campo.id] || '';
    area.addEventListener('input', () => {
      state.mensagens.valores[campo.id] = area.value;
      marca.textContent = area.value.trim() ? 'personalizada' : 'padrão';
    });
    bloco.append(area);

    const vars = el('div', 'vars');
    for (const variavel of campo.variaveis) {
      const btn = el('button', null, variavel);
      btn.addEventListener('click', () => {
        const pos = area.selectionStart || area.value.length;
        area.value = area.value.slice(0, pos) + variavel + area.value.slice(pos);
        state.mensagens.valores[campo.id] = area.value;
        marca.textContent = 'personalizada';
        area.focus();
        area.setSelectionRange(pos + variavel.length, pos + variavel.length);
      });
      vars.append(btn);
    }
    const restaurar = el('button', 'ghost', '↩ Voltar ao padrão');
    restaurar.addEventListener('click', () => {
      area.value = '';
      state.mensagens.valores[campo.id] = '';
      marca.textContent = 'padrão';
    });
    vars.append(restaurar);
    bloco.append(vars);
    panel.append(bloco);
  }

  const botao = el('button', null, 'Salvar mensagens');
  botao.addEventListener('click', () => salvar().catch((err) => toast(err.message)));
  panel.append(botao);
}

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/** Campo simples com rótulo, devolvendo o input para quem chamou. */
function campoLinha(rotulo, valor, tipo = 'text') {
  const box = el('div', 'field');
  box.append(el('label', null, rotulo));
  const input = el('input');
  input.type = tipo;
  input.value = valor === undefined || valor === null ? '' : valor;
  box.append(input);
  return { box, input };
}

function faixasDoTexto(texto) {
  const faixas = [];
  for (const parte of texto.split(',').map((t) => t.trim()).filter(Boolean)) {
    const m = parte.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!m) return { erro: `Faixa inválida: "${parte}"` };
    faixas.push({ start: m[1].padStart(5, '0'), end: m[2].padStart(5, '0') });
  }
  return { faixas };
}

/** Seção Equipe: quem atende, quando atende e o que o consultório oferece. */
function renderEquipe() {
  const panel = $('#tab-equipe');
  if (!panel) return;
  const foco = document.activeElement;
  if (panel.childElementCount && panel.contains(foco)
      && (foco.tagName === 'TEXTAREA' || foco.tagName === 'INPUT')) return;

  panel.innerHTML = '';
  const clinic = state.data.clinic;

  panel.append(el('div', 'day-title', `Profissionais (${clinic.professionals.length})`));

  for (const p of clinic.professionals) {
    const bloco = el('div', 'msg-block');
    const cabecalho = el('div', 'row');
    cabecalho.append(el('span', 'title', p.name));
    const remover = el('button', 'ghost danger', '🗑 Remover');
    remover.addEventListener('click', async () => {
      if (!confirm(`Remover ${p.name} da equipe?`)) return;
      try {
        await api(`/api/professionals/${p.id}`, { method: 'DELETE' });
        toast('Profissional removido');
        await carregar();
      } catch (err) { toast(err.message); }
    });
    cabecalho.append(remover);
    bloco.append(cabecalho);

    const nome = campoLinha('Nome (como aparece para o paciente)', p.name);
    const especialidade = campoLinha('Especialidade', p.specialty);
    const crm = campoLinha('CRM', p.crm);
    const grade = campoLinha('Grade da agenda (minutos)', p.slotMinutes, 'number');
    grade.input.min = '5';
    grade.input.step = '5';
    bloco.append(nome.box, especialidade.box, crm.box, grade.box);

    bloco.append(el('div', 'desc',
      'Horários de atendimento por dia, separados por vírgula. Ex.: 08:00-12:00, 14:00-18:00. Vazio = não atende.'));
    const entradas = [];
    for (let dia = 0; dia < 7; dia += 1) {
      const linha = el('div', 'week-row');
      linha.append(el('label', null, DIAS[dia]));
      const input = el('input');
      input.type = 'text';
      input.placeholder = 'não atende';
      input.value = (p.weekly[dia] || []).map((r) => `${r.start}-${r.end}`).join(', ');
      linha.append(input);
      bloco.append(linha);
      entradas.push(input);
    }

    // Férias e feriados: fechar um dia específico sem mexer na semana toda.
    const bloqueadas = Object.keys(p.exceptions || {})
      .filter((d) => Array.isArray(p.exceptions[d]) && !p.exceptions[d].length)
      .sort();
    bloco.append(el('div', 'day-title', 'Dias bloqueados (férias, congresso, feriado)'));
    if (!bloqueadas.length) bloco.append(el('div', 'desc', 'Nenhum dia bloqueado.'));
    for (const data of bloqueadas) {
      const linha = el('div', 'conv-row');
      linha.append(el('span', 'conv-name', data.split('-').reverse().join('/')));
      const tirar = el('button', 'ghost', '✕');
      tirar.title = 'Voltar a atender neste dia';
      tirar.addEventListener('click', async () => {
        const excecoes = { ...(p.exceptions || {}) };
        delete excecoes[data];
        await api(`/api/professionals/${p.id}`, { method: 'PUT', body: { exceptions: excecoes } });
        toast('Dia liberado');
        await carregar();
      });
      linha.append(tirar);
      bloco.append(linha);
    }
    const novaData = el('div', 'conv-add');
    const dataInput = el('input');
    dataInput.type = 'date';
    const bloquear = el('button', 'ghost', 'Bloquear dia');
    bloquear.addEventListener('click', async () => {
      if (!dataInput.value) return toast('Escolha a data');
      const excecoes = { ...(p.exceptions || {}), [dataInput.value]: [] };
      await api(`/api/professionals/${p.id}`, { method: 'PUT', body: { exceptions: excecoes } });
      toast('Dia bloqueado');
      await carregar();
      return undefined;
    });
    novaData.append(dataInput, bloquear);
    bloco.append(novaData);

    const salvar = el('button', null, 'Salvar profissional');
    salvar.addEventListener('click', async () => {
      const weekly = {};
      for (let dia = 0; dia < 7; dia += 1) {
        const { faixas, erro } = faixasDoTexto(entradas[dia].value);
        if (erro) return toast(`${DIAS[dia]}: ${erro}`);
        weekly[dia] = faixas;
      }
      try {
        await api(`/api/professionals/${p.id}`, {
          method: 'PUT',
          body: {
            name: nome.input.value.trim(),
            specialty: especialidade.input.value.trim(),
            crm: crm.input.value.trim(),
            slotMinutes: Number(grade.input.value) || 30,
            weekly,
          },
        });
        toast('Profissional salvo');
        await carregar();
      } catch (err) { toast(err.message); }
      return undefined;
    });
    bloco.append(salvar);
    panel.append(bloco);
  }

  // Novo profissional
  const novo = el('div', 'msg-block');
  novo.append(el('div', 'title', '+ Adicionar profissional'));
  const nNome = campoLinha('Nome', '');
  const nEsp = campoLinha('Especialidade', clinic.specialty || '');
  const nCrm = campoLinha('CRM', '');
  novo.append(nNome.box, nEsp.box, nCrm.box);
  const criar = el('button', null, 'Adicionar');
  criar.addEventListener('click', async () => {
    try {
      await api('/api/professionals', {
        method: 'POST',
        body: { name: nNome.input.value, specialty: nEsp.input.value, crm: nCrm.input.value },
      });
      toast('Profissional adicionado — agora defina a agenda dele');
      await carregar();
    } catch (err) { toast(err.message); }
  });
  novo.append(criar);
  panel.append(novo);

  // ---------- tipos de atendimento ----------

  panel.append(el('hr'));
  panel.append(el('div', 'day-title', `Tipos de atendimento (${clinic.services.length})`));
  panel.append(el('div', 'desc',
    'A duração define a grade de horários e o quanto a consulta ocupa na agenda.'));

  for (const servico of clinic.services) {
    const bloco = el('div', 'msg-block');
    const cabecalho = el('div', 'row');
    cabecalho.append(el('span', 'title', servico.name));
    const remover = el('button', 'ghost danger', '🗑 Remover');
    remover.addEventListener('click', async () => {
      if (!confirm(`Remover o atendimento "${servico.name}"?`)) return;
      try {
        await api(`/api/services/${servico.id}`, { method: 'DELETE' });
        toast('Atendimento removido');
        await carregar();
      } catch (err) { toast(err.message); }
    });
    cabecalho.append(remover);
    bloco.append(cabecalho);

    const nome = campoLinha('Nome', servico.name);
    const duracao = campoLinha('Duração (minutos)', servico.durationMin, 'number');
    const preco = campoLinha('Valor', servico.price || '');
    const retorno = campoLinha('Lembrete de retorno (dias, 0 = não envia)', servico.returnDays || 0, 'number');
    bloco.append(nome.box, duracao.box, preco.box, retorno.box);

    const inclui = el('div', 'field');
    inclui.append(el('label', null, 'O que está incluso (um por linha)'));
    const incluiArea = el('textarea');
    incluiArea.rows = 3;
    incluiArea.value = (servico.includes || []).join('\n');
    inclui.append(incluiArea);
    bloco.append(inclui);

    const preparo = el('div', 'field');
    preparo.append(el('label', null, 'Preparo (vai nos lembretes)'));
    const preparoArea = el('textarea');
    preparoArea.rows = 2;
    preparoArea.value = servico.prep || '';
    preparo.append(preparoArea);
    bloco.append(preparo);

    const salvar = el('button', null, 'Salvar atendimento');
    salvar.addEventListener('click', async () => {
      try {
        await api(`/api/services/${servico.id}`, {
          method: 'PUT',
          body: {
            name: nome.input.value,
            durationMin: duracao.input.value,
            price: preco.input.value,
            returnDays: retorno.input.value,
            includes: incluiArea.value,
            prep: preparoArea.value,
          },
        });
        toast('Atendimento salvo');
        await carregar();
      } catch (err) { toast(err.message); }
    });
    bloco.append(salvar);
    panel.append(bloco);
  }

  const novoServico = el('div', 'msg-block');
  novoServico.append(el('div', 'title', '+ Adicionar tipo de atendimento'));
  const sNome = campoLinha('Nome', '');
  const sDur = campoLinha('Duração (minutos)', 30, 'number');
  novoServico.append(sNome.box, sDur.box);
  const criarServico = el('button', null, 'Adicionar');
  criarServico.addEventListener('click', async () => {
    try {
      await api('/api/services', {
        method: 'POST', body: { name: sNome.input.value, durationMin: sDur.input.value },
      });
      toast('Atendimento criado');
      await carregar();
    } catch (err) { toast(err.message); }
  });
  novoServico.append(criarServico);
  panel.append(novoServico);
}

function campo(label, valor, id, multilinha) {
  const box = el('div', 'field');
  box.append(el('label', null, label));
  const input = el(multilinha ? 'textarea' : 'input');
  input.id = id;
  input.value = valor || '';
  box.append(input);
  return box;
}

/**
 * Cadastro de convênios: dá para desligar um plano sem apagá-lo (credenciamento
 * suspenso) ou desligar todos de uma vez, quando o consultório é só particular.
 */
function blocoConvenios(c) {
  // O painel se redesenha a cada evento do servidor. As edições ainda não
  // salvas precisam sobreviver a isso — só recarregamos do servidor quando o
  // cadastro mudou de verdade lá.
  const assinatura = JSON.stringify([c.acceptsInsurance !== false, c.insurances]);
  if (!state.convenios || state.convenios.assinatura !== assinatura) {
    state.convenios = {
      assinatura,
      aceita: c.acceptsInsurance !== false,
      lista: (c.insurances || []).map((i) => (typeof i === 'string' ? { name: i, active: true } : { ...i })),
    };
  }

  const box = el('div', 'field');
  box.append(el('label', null, 'Convênios'));

  const modo = el('label', 'switch-row');
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.checked = state.convenios.aceita;
  toggle.addEventListener('change', () => {
    state.convenios.aceita = toggle.checked;
    renderConfig();
  });
  modo.append(toggle, el('span', null, 'Atendemos por convênio'));
  box.append(modo);

  if (!state.convenios.aceita) {
    box.append(el('div', 'warn-note',
      'Modo particular: o bot não pergunta convênio, avisa que o atendimento é só particular '
      + 'e já segue para o horário. Os planos abaixo ficam guardados para quando voltar.'));
  }

  const lista = el('div', 'conv-list');
  for (const convenio of state.convenios.lista) {
    const linha = el('div', 'conv-row');
    const ativo = el('input');
    ativo.type = 'checkbox';
    ativo.checked = convenio.active !== false;
    ativo.disabled = !state.convenios.aceita;
    ativo.title = 'Atendendo agora';
    ativo.addEventListener('change', () => { convenio.active = ativo.checked; renderConfig(); });
    linha.append(ativo);

    const nome = el('span', `conv-name ${convenio.active === false || !state.convenios.aceita ? 'off' : ''}`,
      convenio.name);
    linha.append(nome);
    if (convenio.active === false) linha.append(el('span', 'badge aguardando', 'suspenso'));

    const remover = el('button', 'ghost', '✕');
    remover.title = 'Remover do cadastro';
    remover.addEventListener('click', () => {
      state.convenios.lista = state.convenios.lista.filter((x) => x !== convenio);
      renderConfig();
    });
    linha.append(remover);
    lista.append(linha);
  }
  if (!state.convenios.lista.length) lista.append(el('div', 'desc', 'Nenhum convênio cadastrado.'));
  box.append(lista);

  const adicionar = el('div', 'conv-add');
  const entrada = el('input');
  entrada.type = 'text';
  entrada.placeholder = 'Adicionar convênio…';
  const botaoAdd = el('button', 'ghost', 'Adicionar');
  const incluir = () => {
    const nome = entrada.value.trim();
    if (!nome) return;
    if (state.convenios.lista.some((x) => x.name.toLowerCase() === nome.toLowerCase())) {
      return toast('Esse convênio já está no cadastro');
    }
    state.convenios.lista.push({ name: nome, active: true });
    renderConfig();
  };
  botaoAdd.addEventListener('click', incluir);
  entrada.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); incluir(); } });
  adicionar.append(entrada, botaoAdd);
  box.append(adicionar);

  box.append(el('div', 'desc', 'Desmarcar o quadrado deixa o plano suspenso: fica no cadastro, '
    + 'mas o bot não oferece e avisa que o credenciamento está pausado.'));
  return box;
}

function renderConfig() {
  const panel = $('#tab-config');
  // Não redesenha por cima de quem está digitando — mas marcar uma caixa
  // precisa redesenhar, senão o resto da tela não acompanha a mudança.
  const foco = document.activeElement;
  const digitando = foco && panel.contains(foco)
    && (foco.tagName === 'TEXTAREA' || (foco.tagName === 'INPUT' && foco.type !== 'checkbox'));
  if (panel.childElementCount && digitando) return;
  panel.innerHTML = '';
  const c = state.data.clinic;

  panel.append(el('div', 'day-title', 'Dados do consultório'));
  panel.append(campo('Nome', c.name, 'cfgName'));
  panel.append(campo('Especialidade', c.specialty, 'cfgSpecialty'));
  panel.append(campo('Nome da assistente virtual', c.assistantName, 'cfgAssistant'));
  panel.append(campo('Telefone', c.phone, 'cfgPhone'));
  panel.append(campo('Horário de funcionamento (texto)', c.hoursText, 'cfgHours'));
  panel.append(campo('Endereço', c.address, 'cfgAddress', true));
  panel.append(campo('Referência do endereço', c.addressHint, 'cfgHint', true));
  panel.append(blocoConvenios(c));
  panel.append(campo('Valor particular', c.privatePrice, 'cfgPrice', true));
  panel.append(campo('O que levar (vírgula)', c.documents.join(', '), 'cfgDocs', true));

  const salvar = el('button', null, 'Salvar dados');
  salvar.addEventListener('click', async () => {
    await api('/api/clinic', {
      method: 'PUT',
      body: {
        name: $('#cfgName').value,
        specialty: $('#cfgSpecialty').value,
        assistantName: $('#cfgAssistant').value,
        phone: $('#cfgPhone').value,
        hoursText: $('#cfgHours').value,
        address: $('#cfgAddress').value,
        addressHint: $('#cfgHint').value,
        acceptsInsurance: state.convenios.aceita,
        insurances: state.convenios.lista,
        privatePrice: $('#cfgPrice').value,
        documents: $('#cfgDocs').value.split(',').map((s) => s.trim()).filter(Boolean),
      },
    });
    state.convenios = null;
    toast('Dados atualizados');
    await carregar();
  });
  panel.append(salvar);

  blocoWhatsApp(panel);
  blocoRegras(panel);
  blocoAcesso(panel);
}

// ---------- ações ----------

async function enviar(direcao, texto) {
  const paciente = pacientePorId(state.selected);
  if (!paciente || !texto.trim()) return;
  try {
    if (direcao === 'in') {
      await api('/api/simulate', { method: 'POST', body: { phone: paciente.phone, body: texto } });
    } else {
      await api('/api/messages', { method: 'POST', body: { contactId: paciente.id, body: texto } });
    }
    await carregar();
  } catch (err) {
    toast(err.message);
  }
}

/** Simula o paciente mandando áudio ou foto. */
async function enviarMidia(tipo) {
  const paciente = pacientePorId(state.selected);
  if (!paciente) return toast('Selecione um paciente');
  try {
    await api('/api/simulate', { method: 'POST', body: { phone: paciente.phone, mediaType: tipo } });
    await carregar();
  } catch (err) {
    toast(err.message);
  }
}

async function carregar() {
  try {
    state.data = await api('/api/state');
  } catch (err) {
    if (err.semSessao) return;
    throw err;
  }
  esconderLogin();
  $('#senhaPadraoAviso').hidden = !(state.data.user && state.data.user.mustChangePassword);
  $('#botDesligadoAviso').hidden = state.data.clinic.botEnabled !== false;
  if (!state.selected && state.data.contacts.length) state.selected = state.data.contacts[0].id;
  render();
}

function ligarEventos() {
  $('#loginForm').addEventListener('submit', entrar);
  $('#btnLogout').addEventListener('click', sair);

  $('#searchContacts').addEventListener('input', (e) => {
    state.filtro = e.target.value;
    renderContacts();
  });

  $('#btnNewContact').addEventListener('click', async () => {
    const phone = prompt('Número do paciente (ex.: 5511999999999):');
    if (!phone) return;
    const limpo = phone.replace(/\D/g, '');
    const body = prompt('Primeira mensagem do paciente:', 'Oi, bom dia') || 'Oi';
    await api('/api/simulate', { method: 'POST', body: { phone: limpo, body } });
    const dados = await api('/api/state');
    const criado = dados.contacts.find((c) => c.phone === limpo);
    if (criado) {
      state.selected = criado.id;
      localStorage.setItem('pacienteSelecionado', criado.id);
    }
    await carregar();
  });

  $('#btnFollowups').addEventListener('click', async () => {
    if (!state.selected) return toast('Selecione um paciente');
    await api(`/api/contacts/${state.selected}/followups`, { method: 'POST' });
    toast('Lembretes de 1/7/15 dias reagendados');
    await carregar();
  });

  $('#btnExport').addEventListener('click', async () => {
    if (!state.selected) return toast('Selecione um paciente');
    const paciente = pacientePorId(state.selected);
    const dados = await api(`/api/contacts/${state.selected}/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' }));
    const a = el('a');
    a.href = url;
    a.download = `dados-${(paciente.name || paciente.phone).replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Arquivo gerado');
    return undefined;
  });

  $('#btnErase').addEventListener('click', async () => {
    if (!state.selected) return toast('Selecione um paciente');
    const paciente = pacientePorId(state.selected);
    const nome = nomePaciente(paciente);
    // Exclusão é irreversível: pedir o nome evita o clique errado na correria.
    const confirmacao = prompt(
      `Isto apaga em definitivo o cadastro, as conversas e os lembretes de ${nome}.\n`
      + 'As consultas continuam na estatística, sem nome.\n\n'
      + `Para confirmar, escreva o nome do paciente:`,
    );
    if (confirmacao === null) return undefined;
    if (confirmacao.trim().toLowerCase() !== nome.toLowerCase()) return toast('Nome não confere — nada foi apagado');

    const resumo = await api(`/api/contacts/${state.selected}`, { method: 'DELETE' });
    state.selected = null;
    localStorage.removeItem('pacienteSelecionado');
    toast(`Dados apagados (${resumo.mensagens} mensagens, ${resumo.consultasAnonimizadas} consulta(s) anonimizada(s))`);
    await carregar();
    return undefined;
  });

  $('#btnRelease').addEventListener('click', async () => {
    if (!state.selected) return toast('Selecione um paciente');
    await api(`/api/contacts/${state.selected}/release`, { method: 'POST' });
    toast('Conversa devolvida ao atendimento automático');
    await carregar();
  });

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#composerInput');
    const texto = input.value;
    input.value = '';
    await enviar($('#sendAs').value, texto);
  });

  // Uma caixa de seleção em vez de abas: cabe em qualquer largura e nenhuma
  // seção fica escondida atrás de rolagem.
  const seletor = $('#tabSelect');
  const trocarSecao = () => {
    state.tab = seletor.value;
    localStorage.setItem('secaoPainel', state.tab);
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${state.tab}`);
    });
  };
  seletor.addEventListener('change', trocarSecao);

  const guardada = localStorage.getItem('secaoPainel');
  if (guardada && seletor.querySelector(`option[value="${guardada}"]`)) seletor.value = guardada;
  trocarSecao();

  const stream = new EventSource('/api/stream');
  let agendado = null;
  stream.onmessage = () => {
    clearTimeout(agendado);
    agendado = setTimeout(() => carregar().catch(() => {}), 250);
  };
}

/**
 * Conexão do WhatsApp: status e QR Code direto no painel.
 * Enquanto o código não é lido, consulta a cada 5s — o WhatsApp troca o QR
 * sozinho de tempos em tempos, e um código velho não conecta.
 */
function blocoWhatsApp(panel) {
  panel.append(el('hr'));
  panel.append(el('div', 'day-title', 'Conexão do WhatsApp'));

  const caixa = el('div', 'item');
  caixa.id = 'blocoWhatsApp';
  caixa.append(el('div', 'desc', 'Consultando…'));
  panel.append(caixa);

  const desenhar = (dados) => {
    caixa.innerHTML = '';

    // O interruptor vem primeiro: é o que a recepção mais mexe.
    const chave = el('label', 'switch-row');
    const marca = el('input');
    marca.type = 'checkbox';
    marca.checked = dados.botAtivo;
    marca.addEventListener('change', async () => {
      try {
        await api('/api/bot', { method: 'POST', body: { enabled: marca.checked } });
        toast(marca.checked
          ? 'Atendimento automático ligado'
          : 'Atendimento automático desligado — as mensagens vão para a recepção');
        await carregar();
      } catch (err) { toast(err.message); }
    });
    chave.append(marca, el('span', null, 'Atendimento automático (o bot responde sozinho)'));
    caixa.append(chave);
    if (!dados.botAtivo) {
      caixa.append(el('div', 'desc',
        'Desligado: as mensagens continuam chegando e aparecem aqui, mas ninguém responde '
        + 'automaticamente. Os lembretes já programados continuam saindo.'));
    }
    caixa.append(el('hr'));

    if (String(dados.status || '').startsWith('erro')) {
      caixa.append(el('div', 'title', '⚠️ O WhatsApp não conseguiu iniciar'));
      caixa.append(el('div', 'desc', dados.status));
      caixa.append(el('div', 'warn-note',
        'No servidor, veja o motivo com: journalctl -u botwhats -n 80 --no-pager — '
        + 'e confira o Chrome com: npm run diagnostico'));
      return;
    }

    if (dados.canal !== 'whatsapp') {
      caixa.append(el('div', 'title', 'Modo simulador'));
      caixa.append(el('div', 'desc',
        'As mensagens ficam só neste painel. Para conectar um número de verdade, '
        + 'coloque CHANNEL=whatsapp no arquivo .env do servidor e reinicie.'));
      return;
    }
    if (dados.conectado) {
      caixa.append(el('div', 'title', '✅ WhatsApp conectado'));
      caixa.append(el('div', 'desc',
        'Se o aparelho for desconectado algum dia, o QR Code reaparece aqui.'));
      if (dados.podeDesconectar) {
        const sair = el('button', 'ghost danger', 'Desconectar este número');
        sair.title = 'Desvincula o aparelho e mostra um QR novo, para conectar outro número';
        sair.addEventListener('click', async () => {
          if (!confirm('Desconectar o número atual? O bot para de atender até você ler um novo QR Code.')) return;
          try {
            await api('/api/whatsapp/logout', { method: 'POST' });
            toast('Desconectado — leia o novo QR Code para vincular um número');
            setTimeout(consultar, 1500);
          } catch (err) { toast(err.message); }
        });
        caixa.append(sair);
      }
      return;
    }

    caixa.append(el('div', 'title', '📱 Conecte o número do consultório'));
    caixa.append(el('div', 'desc',
      `Status: ${dados.status}. No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho, `
      + 'e aponte a câmera para o código abaixo.'));

    if (dados.qrSvg) {
      const moldura = el('div', 'qr-box');
      moldura.innerHTML = dados.qrSvg;
      caixa.append(moldura);
      caixa.append(el('div', 'desc', 'O código muda sozinho a cada poucos segundos — sempre leia o que estiver na tela.'));
    } else if (dados.qrTexto) {
      caixa.append(el('div', 'desc',
        'A biblioteca de desenho do QR não está instalada no servidor. '
        + 'Rode "npm install qrcode" e reinicie, ou leia o código pelo terminal com '
        + '"journalctl -u botwhats -f".'));
    } else {
      caixa.append(el('div', 'desc', 'Aguardando o servidor gerar o código…'));
    }
  };

  const consultar = async () => {
    if (!document.getElementById('blocoWhatsApp')) return; // saiu da tela
    try {
      const dados = await api('/api/whatsapp');
      desenhar(dados);
      if (!dados.conectado && dados.canal === 'whatsapp') setTimeout(consultar, 5000);
    } catch { /* sessão caiu; o login cuida disso */ }
  };
  consultar();
}

/** Regras dos lembretes e da agenda, sem precisar mexer no .env. */
function blocoRegras(panel) {
  const d = state.data;
  panel.append(el('hr'));
  panel.append(el('div', 'day-title', 'Lembretes e regras'));

  const followUp = campoLinha('Follow-up de quem não marcou (dias, separados por vírgula)',
    d.offsets.followUp.join(', '));
  const antes = campoLinha('Lembretes antes da consulta (dias; o de 1 dia é o que pede confirmação)',
    d.offsets.booking.join(', '));
  const vaga = campoLinha('Prazo para responder a uma vaga oferecida (minutos)',
    d.offsets.waitlistOfferMinutes, 'number');
  const escassez = campoLinha('Só falar em "agenda enchendo" acima de (% ocupado)',
    d.offsets.scarcityThreshold, 'number');
  const chegada = campoLinha('Pedir para chegar quantos minutos antes',
    d.clinic.policies.arriveMinutes, 'number');
  const cancelamento = campoLinha('Antecedência mínima para cancelar (horas)',
    d.clinic.policies.cancelHours, 'number');

  panel.append(followUp.box, antes.box, vaga.box, escassez.box, chegada.box, cancelamento.box);

  const numeros = (texto) => texto.split(',').map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const salvar = el('button', null, 'Salvar regras');
  salvar.addEventListener('click', async () => {
    const listaFollowUp = numeros(followUp.input.value);
    const listaAntes = numeros(antes.input.value);
    if (!listaFollowUp.length || !listaAntes.length) {
      return toast('Informe ao menos um dia em cada régua');
    }
    try {
      await api('/api/clinic', {
        method: 'PUT',
        body: {
          reminders: {
            followUp: listaFollowUp,
            booking: listaAntes.sort((a, b) => b - a),
            waitlistOfferMinutes: Number(vaga.input.value) || 120,
            scarcityThreshold: Number(escassez.input.value) || 80,
          },
          policies: {
            ...d.clinic.policies,
            arriveMinutes: Number(chegada.input.value) || 15,
            cancelHours: Number(cancelamento.input.value) || 24,
          },
        },
      });
      toast('Regras atualizadas');
      await carregar();
    } catch (err) { toast(err.message); }
    return undefined;
  });
  panel.append(salvar);
  panel.append(el('div', 'desc',
    'Vale para os próximos agendamentos; o que já está programado continua como foi criado.'));
}

/** Bloco "Acesso" da aba Ajustes: trocar usuário e senha. */
function blocoAcesso(panel) {
  const user = state.data.user || {};
  panel.append(el('hr'));
  panel.append(el('div', 'day-title', 'Acesso ao painel'));
  panel.append(el('div', 'desc', `Você está logado como ${user.username}.`));

  if (user.mustChangePassword) {
    panel.append(el('div', 'warn-note',
      'Este painel ainda usa a senha padrão. Troque antes de deixar o endereço acessível.'));
  }

  panel.append(campo('Nome de usuário', user.username, 'cfgUsername'));
  const salvarUsuario = el('button', 'ghost', 'Salvar usuário');
  salvarUsuario.addEventListener('click', async () => {
    try {
      await api('/api/account/username', { method: 'POST', body: { username: $('#cfgUsername').value } });
      toast('Nome de usuário atualizado');
      await carregar();
    } catch (err) { toast(err.message); }
  });
  panel.append(salvarUsuario);

  const senhaAtual = campo('Senha atual', '', 'cfgSenhaAtual');
  senhaAtual.querySelector('input').type = 'password';
  const senhaNova = campo('Nova senha (mínimo 8, com letras e números)', '', 'cfgSenhaNova');
  senhaNova.querySelector('input').type = 'password';
  const senhaRepete = campo('Repita a nova senha', '', 'cfgSenhaRepete');
  senhaRepete.querySelector('input').type = 'password';
  panel.append(senhaAtual, senhaNova, senhaRepete);

  const salvarSenha = el('button', null, 'Trocar senha');
  salvarSenha.addEventListener('click', async () => {
    const nova = $('#cfgSenhaNova').value;
    if (nova !== $('#cfgSenhaRepete').value) return toast('A nova senha e a repetição não conferem');
    try {
      await api('/api/account/password', {
        method: 'POST',
        body: { currentPassword: $('#cfgSenhaAtual').value, newPassword: nova },
      });
      // A troca derruba as sessões: entrar de novo é o comportamento esperado.
      toast('Senha alterada — entre de novo');
      state.data = null;
      mostrarLogin('Senha alterada. Entre com a nova senha.');
    } catch (err) { toast(err.message); }
    return undefined;
  });
  panel.append(salvarSenha);
}

ligarEventos();
carregar().catch((err) => { if (!err.semSessao) toast(err.message); });
setInterval(() => carregar().catch(() => {}), 60000);
