'use strict';

const state = {
  data: null,
  selected: localStorage.getItem('contatoSelecionado') || null,
  filtro: '',
  tab: 'agenda',
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
  toast.timer = setTimeout(() => node.classList.remove('show'), 2600);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options && options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha na requisicao');
  return data;
}

// ---------- formatacao ----------

const fmtHora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDia = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const fmtDataHora = (iso) => `${fmtDia(iso)} ${fmtHora(iso)}`;

function fmtRelativo(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const dias = Math.round(diff / 86400000);
  const horas = Math.round(diff / 3600000);
  if (Math.abs(horas) < 1) return diff >= 0 ? 'em minutos' : 'agora ha pouco';
  if (Math.abs(dias) < 1) return diff >= 0 ? `em ${horas}h` : `ha ${-horas}h`;
  return diff >= 0 ? `em ${dias} dia(s)` : `ha ${-dias} dia(s)`;
}

const escapeHtml = (str) => String(str)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Converte a formatacao do WhatsApp (*negrito*, _italico_) em HTML seguro. */
function formatBody(body) {
  return escapeHtml(body)
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

const contatoPorId = (id) => (state.data.contacts || []).find((c) => c.id === id) || null;
const nomeContato = (c) => (c ? c.name || c.phone : 'Contato');

// ---------- render ----------

function render() {
  const d = state.data;
  if (!d) return;

  $('#businessName').textContent = `Painel do Bot · ${d.businessName}`;
  const status = $('#channelStatus');
  const online = d.channel.status === 'conectado';
  status.classList.toggle('online', online);
  status.querySelector('.label').textContent = d.channel.name === 'mock'
    ? 'Simulador ativo'
    : `WhatsApp: ${d.channel.status}`;

  renderKpis();
  renderContacts();
  renderChat();
  renderAgenda();
  renderReminders();
  renderActivity();
  renderHorarios();
}

function renderKpis() {
  const d = state.data;
  const pendentes = d.reminders.filter((r) => r.status === 'pending');
  const enviados = d.reminders.filter((r) => r.status === 'enviado');
  const futuros = d.bookings.filter((b) => b.status === 'confirmado' && new Date(b.startsAt) >= new Date());
  const hoje = new Date().toDateString();
  const msgsHoje = d.messages.filter((m) => new Date(m.at).toDateString() === hoje);

  const kpis = [
    ['Contatos', d.contacts.length],
    ['Mensagens hoje', msgsHoje.length],
    ['Agendamentos', futuros.length],
    ['Lembretes pendentes', pendentes.length],
    ['Lembretes enviados', enviados.length],
  ];
  const box = $('#kpis');
  box.innerHTML = '';
  for (const [label, value] of kpis) {
    const card = el('div', 'kpi');
    card.append(el('div', 'value', String(value)), el('div', 'label', label));
    box.append(card);
  }
}

function renderContacts() {
  const list = $('#contactList');
  list.innerHTML = '';
  const filtro = state.filtro.toLowerCase();
  const contatos = state.data.contacts
    .filter((c) => !filtro || (c.name || '').toLowerCase().includes(filtro) || c.phone.includes(filtro))
    .sort((a, b) => new Date(b.lastMessage ? b.lastMessage.at : b.createdAt)
      - new Date(a.lastMessage ? a.lastMessage.at : a.createdAt));

  if (!contatos.length) {
    list.append(el('div', 'empty', 'Nenhuma conversa ainda. Use "+ Novo" para simular um cliente.'));
    return;
  }

  for (const c of contatos) {
    const li = el('li');
    if (c.id === state.selected) li.classList.add('active');

    const row = el('div', 'contact-row');
    row.append(el('span', 'contact-name', nomeContato(c)));
    row.append(el('span', `badge ${c.stage.replace(/\s+/g, '-')}`, c.stage));
    li.append(row);

    const row2 = el('div', 'contact-row');
    row2.append(el('span', 'contact-last', c.lastMessage
      ? `${c.lastMessage.direction === 'out' ? '↩ ' : ''}${c.lastMessage.body.slice(0, 38)}`
      : c.phone));
    if (c.lastMessage) row2.append(el('span', 'time', fmtDataHora(c.lastMessage.at)));
    li.append(row2);

    li.addEventListener('click', () => {
      state.selected = c.id;
      localStorage.setItem('contatoSelecionado', c.id);
      render();
    });
    list.append(li);
  }
}

function renderChat() {
  const box = $('#messages');
  const contato = contatoPorId(state.selected);
  box.innerHTML = '';

  if (!contato) {
    $('#chatName').textContent = 'Selecione uma conversa';
    $('#chatMeta').textContent = 'O simulador permite testar o bot sem conectar o WhatsApp';
    box.append(el('div', 'empty', 'Escolha um contato à esquerda para ver as interações.'));
    renderQuickReplies();
    return;
  }

  $('#chatName').textContent = nomeContato(contato);
  const agendamento = state.data.bookings
    .filter((b) => b.contactId === contato.id && b.status === 'confirmado')
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];
  $('#chatMeta').textContent = [
    contato.phone,
    `etapa: ${contato.state.step}`,
    agendamento ? `agendado ${fmtDataHora(agendamento.startsAt)}` : 'sem agendamento',
  ].join(' · ');

  const msgs = state.data.messages.filter((m) => m.contactId === contato.id);
  if (!msgs.length) box.append(el('div', 'empty', 'Sem mensagens. Envie "oi" pelo simulador.'));

  let ultimoDia = null;
  for (const m of msgs) {
    const dia = new Date(m.at).toLocaleDateString('pt-BR');
    if (dia !== ultimoDia) {
      box.append(el('div', 'day-sep', dia));
      ultimoDia = dia;
    }
    const bubble = el('div', `bubble ${m.direction}`);
    bubble.innerHTML = formatBody(m.body);
    bubble.append(el('span', 'meta', fmtHora(m.at)));
    box.append(bubble);
  }
  box.scrollTop = box.scrollHeight;
  renderQuickReplies();
}

function renderQuickReplies() {
  const box = $('#quickReplies');
  box.innerHTML = '';
  if (!state.selected) return;
  for (const texto of ['Oi', '1', '2', '3', 'AGENDAR', 'SIM', 'MENU', 'CANCELAR', 'SAIR']) {
    const btn = el('button', null, texto);
    btn.addEventListener('click', () => enviar('in', texto));
    box.append(btn);
  }
}

function renderAgenda() {
  const panel = $('#tab-agenda');
  panel.innerHTML = '';
  const contato = contatoPorId(state.selected);

  const proximos = state.data.bookings
    .filter((b) => b.status === 'confirmado' && new Date(b.startsAt) >= new Date())
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));

  panel.append(el('div', 'day-title', `Próximos agendamentos (${proximos.length})`));
  if (!proximos.length) panel.append(el('div', 'empty', 'Nenhum horário marcado.'));
  for (const b of proximos) {
    const item = el('div', 'item');
    const row = el('div', 'row');
    row.append(el('span', 'title', `${fmtDia(b.startsAt)} · ${b.start} às ${b.end}`));
    const cancelar = el('button', 'ghost', 'Cancelar');
    cancelar.addEventListener('click', async () => {
      await api(`/api/bookings/${b.id}`, { method: 'DELETE' });
      toast('Agendamento cancelado');
      await carregar();
    });
    row.append(cancelar);
    item.append(row);
    item.append(el('div', 'desc', nomeContato(contatoPorId(b.contactId))));
    panel.append(item);
  }

  panel.append(el('hr'));
  panel.append(el('div', 'day-title', contato
    ? `Horários livres — clique para marcar com ${nomeContato(contato)}`
    : 'Horários livres (selecione um contato para marcar)'));

  for (const dia of state.data.agendaDays) {
    const bloco = el('div', 'day-block');
    bloco.append(el('div', 'day-title cap', new Date(`${dia.date}T12:00:00`)
      .toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })));
    const slots = el('div', 'slots');
    for (const s of dia.slots) {
      const btn = el('button', 'slot', s.start);
      btn.addEventListener('click', async () => {
        if (!contato) return toast('Selecione um contato primeiro');
        try {
          await api('/api/bookings', {
            method: 'POST',
            body: { contactId: contato.id, date: dia.date, start: s.start },
          });
          toast(`Agendado ${s.start} em ${dia.date}`);
          await carregar();
        } catch (err) { toast(err.message); }
      });
      slots.append(btn);
    }
    bloco.append(slots);
    panel.append(bloco);
  }
  if (!state.data.agendaDays.length) {
    panel.append(el('div', 'empty', 'Sem horários livres nos próximos dias. Configure na aba Horários.'));
  }
}

function renderReminders() {
  const panel = $('#tab-lembretes');
  panel.innerHTML = '';
  const d = state.data;

  panel.append(el('div', 'desc',
    `Follow-up: ${d.offsets.followUp.join('/')} dias após o contato · `
    + `Agendamento: ${d.offsets.booking.join('/')} dias antes`));

  const pendentes = d.reminders
    .filter((r) => r.status === 'pending')
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

  panel.append(el('div', 'day-title', `Pendentes (${pendentes.length})`));
  if (!pendentes.length) panel.append(el('div', 'empty', 'Nenhum lembrete programado.'));

  for (const r of pendentes) {
    const item = el('div', 'item');
    const row = el('div', 'row');
    row.append(el('span', 'title',
      `${r.kind === 'booking' ? '📅' : '🔔'} ${r.offsetDays} dia(s) · ${nomeContato(contatoPorId(r.contactId))}`));
    row.append(el('span', 'time', fmtRelativo(r.dueAt)));
    item.append(row);
    item.append(el('div', 'desc',
      `${r.kind === 'booking' ? 'antes do atendimento' : 'follow-up'} · ${fmtDataHora(r.dueAt)}`));

    const actions = el('div', 'actions');
    const enviarAgora = el('button', 'ghost', 'Enviar agora');
    enviarAgora.addEventListener('click', async () => {
      await api(`/api/reminders/${r.id}/send`, { method: 'POST' });
      toast('Lembrete enviado');
      await carregar();
    });
    const cancelar = el('button', 'ghost', 'Cancelar');
    cancelar.addEventListener('click', async () => {
      await api(`/api/reminders/${r.id}`, { method: 'DELETE' });
      await carregar();
    });
    actions.append(enviarAgora, cancelar);
    item.append(actions);
    panel.append(item);
  }

  const enviados = d.reminders.filter((r) => r.status === 'enviado').slice(-10).reverse();
  if (enviados.length) {
    panel.append(el('div', 'day-title', 'Enviados recentemente'));
    for (const r of enviados) {
      const item = el('div', 'item');
      item.append(el('div', 'title',
        `✅ ${r.offsetDays} dia(s) · ${nomeContato(contatoPorId(r.contactId))}`));
      item.append(el('div', 'desc', fmtDataHora(r.sentAt)));
      panel.append(item);
    }
  }
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

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function renderHorarios() {
  const panel = $('#tab-horarios');
  panel.innerHTML = '';
  const av = state.data.availability;

  const dur = el('div', 'week-row');
  dur.append(el('label', null, 'Duração'));
  const durInput = el('input');
  durInput.type = 'number';
  durInput.min = '15';
  durInput.step = '15';
  durInput.value = av.slotMinutes;
  durInput.id = 'slotMinutes';
  dur.append(durInput);
  panel.append(dur);

  panel.append(el('div', 'desc', 'Faixas por dia, separadas por vírgula. Ex.: 09:00-12:00, 14:00-18:00'));

  for (let dia = 0; dia < 7; dia += 1) {
    const row = el('div', 'week-row');
    row.append(el('label', null, DIAS[dia]));
    const input = el('input');
    input.type = 'text';
    input.dataset.dia = String(dia);
    input.className = 'range-input';
    input.placeholder = 'fechado';
    input.value = (av.weekly[dia] || []).map((r) => `${r.start}-${r.end}`).join(', ');
    row.append(input);
    panel.append(row);
  }

  const salvar = el('button', null, 'Salvar horários');
  salvar.addEventListener('click', async () => {
    const weekly = {};
    let erro = null;
    for (const input of panel.querySelectorAll('.range-input')) {
      const faixas = [];
      for (const parte of input.value.split(',').map((s) => s.trim()).filter(Boolean)) {
        const m = parte.match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
        if (!m) { erro = `Faixa inválida em ${DIAS[input.dataset.dia]}: "${parte}"`; break; }
        faixas.push({ start: m[1], end: m[2] });
      }
      weekly[input.dataset.dia] = faixas;
    }
    if (erro) return toast(erro);
    await api('/api/availability', {
      method: 'PUT',
      body: { slotMinutes: Number(durInput.value) || 60, weekly },
    });
    toast('Horários atualizados');
    await carregar();
  });
  panel.append(salvar);
}

// ---------- acoes ----------

async function enviar(direcao, texto) {
  const contato = contatoPorId(state.selected);
  if (!contato || !texto.trim()) return;
  try {
    if (direcao === 'in') {
      await api('/api/simulate', { method: 'POST', body: { phone: contato.phone, body: texto } });
    } else {
      await api('/api/messages', { method: 'POST', body: { contactId: contato.id, body: texto } });
    }
    await carregar();
  } catch (err) {
    toast(err.message);
  }
}

async function carregar() {
  state.data = await api('/api/state');
  if (!state.selected && state.data.contacts.length) state.selected = state.data.contacts[0].id;
  render();
}

function ligarEventos() {
  $('#searchContacts').addEventListener('input', (e) => {
    state.filtro = e.target.value;
    renderContacts();
  });

  $('#btnNewContact').addEventListener('click', async () => {
    const phone = prompt('Número do contato (ex.: 5511999999999):');
    if (!phone) return;
    const body = prompt('Primeira mensagem do cliente:', 'Oi') || 'Oi';
    await api('/api/simulate', { method: 'POST', body: { phone: phone.replace(/\D/g, ''), body } });
    const dados = await api('/api/state');
    const criado = dados.contacts.find((c) => c.phone === phone.replace(/\D/g, ''));
    if (criado) {
      state.selected = criado.id;
      localStorage.setItem('contatoSelecionado', criado.id);
    }
    await carregar();
  });

  $('#btnFollowups').addEventListener('click', async () => {
    if (!state.selected) return toast('Selecione um contato');
    await api(`/api/contacts/${state.selected}/followups`, { method: 'POST' });
    toast('Lembretes de 1/7/15 dias reagendados');
    await carregar();
  });

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#composerInput');
    const texto = input.value;
    input.value = '';
    await enviar($('#sendAs').value, texto);
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `tab-${state.tab}`);
      });
    });
  }

  const stream = new EventSource('/api/stream');
  let agendado = null;
  stream.onmessage = () => {
    clearTimeout(agendado);
    agendado = setTimeout(() => carregar().catch(() => {}), 250);
  };
}

ligarEventos();
carregar().catch((err) => toast(err.message));
setInterval(() => carregar().catch(() => {}), 60000);
