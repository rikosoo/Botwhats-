'use strict';

/**
 * Google Agenda.
 *
 * O que o consultório ganha: a consulta marcada pelo bot ou pela recepção
 * aparece no celular do médico, no calendário que ele já usa, sem ninguém
 * abrir o painel. Remarcou, confirmou ou cancelou aqui, muda lá.
 *
 * O caminho contrário — evento criado no Google virar bloqueio na agenda do
 * bot — é opcional e vale a pena: sem ele, um compromisso pessoal marcado no
 * celular continua sendo oferecido como horário livre para o paciente.
 *
 * Não há dependência nova: o Google fala HTTP e JSON, e o `fetch` do Node 22
 * dá conta. O que existe aqui é a dança do OAuth e a tradução de consulta
 * para evento.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';

// `calendar` cobre criar/editar eventos e listar os calendários da conta, que
// é o que a tela de configuração precisa mostrar.
const ESCOPO = 'https://www.googleapis.com/auth/calendar';

const PADRAO = {
  clientId: '',
  clientSecret: '',
  redirectUri: 'http://localhost:3000/api/google/callback',
  refreshToken: '',
  calendarId: 'primary',
  calendarName: '',
  conta: '',
  enabled: false,
  bloquearOcupados: false,
  // Qual médico esta agenda representa. Vazio = o consultório inteiro, que é
  // o caso de quem atende sozinho.
  professionalId: '',
  lastError: null,
  lastSyncAt: null,
};

/** Erro com mensagem já em português, para subir direto ao painel. */
class ErroGoogle extends Error {}

class GoogleCalendar {
  constructor(store, config, { fetchImpl = null, agora = () => Date.now() } = {}) {
    this.store = store;
    this.config = config;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.agora = agora;
    this.tokenCache = null;      // { token, expiraEm }
    this.ocupados = new Map();   // data -> [{start,end}] vindos do Google
  }

  get conf() {
    const integrations = this.store.state.integrations || (this.store.state.integrations = {});
    if (!integrations.google) integrations.google = { ...PADRAO };
    return integrations.google;
  }

  salvar() {
    this.store.commit('integrations', this.estado());
  }

  /** O que o painel pode ver: nunca o segredo, nunca o refresh token. */
  estado() {
    const c = this.conf;
    return {
      configurado: Boolean(c.clientId && c.clientSecret),
      conectado: Boolean(c.refreshToken),
      enabled: Boolean(c.enabled),
      bloquearOcupados: Boolean(c.bloquearOcupados),
      professionalId: c.professionalId || '',
      clientId: c.clientId || '',
      redirectUri: c.redirectUri || PADRAO.redirectUri,
      calendarId: c.calendarId || 'primary',
      calendarName: c.calendarName || '',
      conta: c.conta || '',
      lastError: c.lastError || null,
      lastSyncAt: c.lastSyncAt || null,
    };
  }

  guardarCredenciais({ clientId, clientSecret, redirectUri }) {
    const c = this.conf;
    if (clientId !== undefined) c.clientId = String(clientId).trim();
    // Segredo em branco no formulário significa "mantém o que já está salvo" —
    // o painel nunca recebe o valor de volta para reenviar.
    if (clientSecret) c.clientSecret = String(clientSecret).trim();
    if (redirectUri) c.redirectUri = String(redirectUri).trim();
    c.lastError = null;
    this.salvar();
    return this.estado();
  }

  urlDeAutorizacao() {
    const c = this.conf;
    if (!c.clientId || !c.clientSecret) {
      throw new ErroGoogle('Salve antes o ID e a chave do cliente OAuth criados no Google Cloud.');
    }
    const params = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirectUri || PADRAO.redirectUri,
      response_type: 'code',
      scope: ESCOPO,
      // Sem estes dois o Google devolve só um token de uma hora e nunca mais
      // um refresh token — a conexão morreria sozinha no dia seguinte.
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /**
   * Aceita o código puro ou a URL inteira para onde o Google mandou o
   * navegador. Colar a URL é o caminho que funciona mesmo quando o painel não
   * atende em `localhost`: o código está lá, na barra de endereço.
   */
  static extrairCodigo(texto) {
    const bruto = String(texto || '').trim();
    if (!bruto) return '';
    if (!bruto.includes('://') && !bruto.includes('code=')) return bruto;
    try {
      const url = new URL(bruto.includes('://') ? bruto : `http://x/?${bruto.replace(/^\?/, '')}`);
      return url.searchParams.get('code') || '';
    } catch {
      const m = bruto.match(/[?&]code=([^&\s]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    }
  }

  async conectar(codigoOuUrl) {
    const c = this.conf;
    const code = GoogleCalendar.extrairCodigo(codigoOuUrl);
    if (!code) throw new ErroGoogle('Não achei o código na resposta do Google. Cole a URL inteira.');

    const dados = await this.postForm(TOKEN_URL, {
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri || PADRAO.redirectUri,
      grant_type: 'authorization_code',
    });
    if (!dados.refresh_token) {
      throw new ErroGoogle('O Google não devolveu a autorização de longo prazo. '
        + 'Refaça a conexão pelo botão do painel (ele pede o consentimento de novo).');
    }
    c.refreshToken = dados.refresh_token;
    this.tokenCache = {
      token: dados.access_token,
      expiraEm: this.agora() + (Number(dados.expires_in || 3600) - 60) * 1000,
    };
    c.enabled = true;
    c.lastError = null;

    // Qual conta acabou de entrar: o calendário principal tem o e-mail como id.
    try {
      const principal = await this.chamar('/users/me/calendarList/primary');
      c.conta = principal.id || '';
      if (!c.calendarId || c.calendarId === 'primary') {
        c.calendarId = principal.id || 'primary';
        c.calendarName = principal.summary || '';
      }
    } catch { /* conectou; o nome da conta é só enfeite */ }

    this.salvar();
    return this.estado();
  }

  async desconectar() {
    const c = this.conf;
    if (c.refreshToken) {
      // Revogar é o que tira o acesso de verdade; apagar só daqui deixaria a
      // permissão pendurada na conta do Google.
      try {
        await this.postForm(REVOKE_URL, { token: c.refreshToken });
      } catch { /* se já estava revogado, seguimos */ }
    }
    Object.assign(c, {
      refreshToken: '', conta: '', enabled: false, calendarName: '',
      calendarId: 'primary', lastError: null, lastSyncAt: null,
    });
    this.tokenCache = null;
    this.ocupados.clear();
    this.salvar();
    return this.estado();
  }

  ligar(ligado) {
    this.conf.enabled = Boolean(ligado);
    this.salvar();
    return this.estado();
  }

  bloquearOcupados(ligado) {
    this.conf.bloquearOcupados = Boolean(ligado);
    if (!ligado) this.ocupados.clear();
    this.salvar();
    return this.estado();
  }

  async listarCalendarios() {
    const dados = await this.chamar('/users/me/calendarList');
    return (dados.items || [])
      .filter((cal) => cal.accessRole === 'owner' || cal.accessRole === 'writer')
      .map((cal) => ({ id: cal.id, nome: cal.summary, principal: Boolean(cal.primary) }));
  }

  escolherCalendario(id, nome = '') {
    const c = this.conf;
    c.calendarId = String(id || 'primary');
    c.calendarName = nome || '';
    this.salvar();
    return this.estado();
  }

  // ---------- token ----------

  async accessToken() {
    const c = this.conf;
    if (!c.refreshToken) throw new ErroGoogle('Google Agenda ainda não está conectado.');
    if (this.tokenCache && this.tokenCache.expiraEm > this.agora()) return this.tokenCache.token;
    const dados = await this.postForm(TOKEN_URL, {
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token',
    });
    this.tokenCache = {
      token: dados.access_token,
      expiraEm: this.agora() + (Number(dados.expires_in || 3600) - 60) * 1000,
    };
    return this.tokenCache.token;
  }

  async postForm(url, campos) {
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(campos).toString(),
    });
    const texto = await res.text();
    let corpo = {};
    try { corpo = texto ? JSON.parse(texto) : {}; } catch { corpo = { raw: texto }; }
    if (!res.ok) {
      const detalhe = corpo.error_description || corpo.error || texto || `HTTP ${res.status}`;
      throw new ErroGoogle(`Google recusou: ${detalhe}`);
    }
    return corpo;
  }

  async chamar(caminho, { method = 'GET', body = null, query = null } = {}) {
    const token = await this.accessToken();
    const url = `${API}${caminho}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return {};
    const texto = await res.text();
    let corpo = {};
    try { corpo = texto ? JSON.parse(texto) : {}; } catch { corpo = { raw: texto }; }
    if (!res.ok) {
      const detalhe = (corpo.error && (corpo.error.message || corpo.error)) || `HTTP ${res.status}`;
      const erro = new ErroGoogle(`Google Agenda: ${detalhe}`);
      erro.status = res.status;
      throw erro;
    }
    return corpo;
  }

  // ---------- consultas viram eventos ----------

  ativo() {
    const c = this.conf;
    return Boolean(c.refreshToken && c.enabled);
  }

  evento(booking) {
    const contato = this.store.getContact(booking.contactId);
    const paciente = contato ? (contato.name || contato.phone) : 'Paciente';
    const fim = new Date(new Date(booking.startsAt).getTime()
      + minutosEntre(booking.start, booking.end) * 60000);
    const linhas = [
      `Paciente: ${paciente}`,
      contato && contato.phone ? `WhatsApp: ${contato.phone}` : null,
      `Atendimento: ${booking.serviceName}`,
      `Profissional: ${booking.professionalName}`,
      booking.insurance ? `Convênio: ${booking.insurance}` : 'Particular',
      booking.confirmation === 'confirmado' ? 'Presença confirmada pelo paciente.' : null,
      booking.note ? `Observação: ${booking.note}` : null,
      '',
      'Criado pelo painel do consultório.',
    ].filter(Boolean);

    return {
      summary: `${paciente} — ${booking.serviceName}`,
      description: linhas.join('\n'),
      start: { dateTime: new Date(booking.startsAt).toISOString(), timeZone: this.config.timezone },
      end: { dateTime: fim.toISOString(), timeZone: this.config.timezone },
      // A marca permite reencontrar o evento mesmo se o id local se perder.
      extendedProperties: { private: { consultaId: booking.id } },
    };
  }

  /**
   * Espelha uma consulta no Google: cria, atualiza ou apaga conforme o estado.
   * Nunca deixa o erro subir para quem marcou a consulta — a agenda do
   * consultório é a verdade; o Google é uma cópia conveniente.
   */
  async sincronizar(booking) {
    if (!this.ativo() || !booking) return null;
    const c = this.conf;
    try {
      if (booking.status !== 'confirmado') {
        if (!booking.googleEventId) return null;
        await this.chamar(`/calendars/${encodeURIComponent(c.calendarId)}/events/${booking.googleEventId}`,
          { method: 'DELETE' });
        delete booking.googleEventId;
        this.marcarSincronia();
        return null;
      }
      if (booking.googleEventId) {
        const atualizado = await this.chamar(
          `/calendars/${encodeURIComponent(c.calendarId)}/events/${booking.googleEventId}`,
          { method: 'PUT', body: this.evento(booking) },
        );
        this.marcarSincronia();
        return atualizado;
      }
      const criado = await this.chamar(`/calendars/${encodeURIComponent(c.calendarId)}/events`,
        { method: 'POST', body: this.evento(booking) });
      booking.googleEventId = criado.id;
      this.marcarSincronia();
      return criado;
    } catch (err) {
      // Evento apagado à mão no Google não é problema: recria na próxima.
      if (err.status === 404 || err.status === 410) {
        delete booking.googleEventId;
        return null;
      }
      c.lastError = err.message;
      this.salvar();
      this.store.logEvent('erro', `Google Agenda: ${err.message}`);
      return null;
    }
  }

  marcarSincronia() {
    const c = this.conf;
    c.lastSyncAt = new Date().toISOString();
    c.lastError = null;
  }

  /** Manda para o Google tudo que já está marcado daqui para frente. */
  async sincronizarFuturas(limite = 200) {
    if (!this.ativo()) return { enviadas: 0 };
    const agora = Date.now();
    const futuras = this.store.state.bookings
      .filter((b) => b.status === 'confirmado' && new Date(b.startsAt).getTime() >= agora)
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
      .slice(0, limite);
    let enviadas = 0;
    for (const booking of futuras) {
      const antes = booking.googleEventId;
      await this.sincronizar(booking);
      if (booking.googleEventId && booking.googleEventId !== antes) enviadas += 1;
    }
    if (futuras.length) this.store.commit('booking', null);
    return { enviadas, total: futuras.length };
  }

  // ---------- o caminho de volta ----------

  /**
   * Compromissos do próprio médico, criados no celular dele, viram intervalos
   * ocupados aqui. Sem isso o bot oferece ao paciente o horário do congresso.
   */
  async atualizarOcupados(dias = 21) {
    if (!this.ativo() || !this.conf.bloquearOcupados) return this.ocupados;
    const inicio = new Date();
    const fim = new Date(inicio.getTime() + dias * 86400000);
    try {
      const dados = await this.chamar(`/calendars/${encodeURIComponent(this.conf.calendarId)}/events`, {
        query: {
          timeMin: inicio.toISOString(),
          timeMax: fim.toISOString(),
          singleEvents: 'true',
          showDeleted: 'false',
          maxResults: '2500',
        },
      });
      const mapa = new Map();
      for (const ev of dados.items || []) {
        // Eventos que este painel criou já estão na agenda como consulta.
        const marca = ev.extendedProperties && ev.extendedProperties.private;
        if (marca && marca.consultaId) continue;
        if (ev.transparency === 'transparent') continue;   // "disponível" no Google
        if (!ev.start || !ev.start.dateTime) {
          // Evento de dia inteiro fecha o dia.
          const data = ev.start && ev.start.date;
          if (data) mapa.set(data, [{ start: '00:00', end: '23:59' }]);
          continue;
        }
        const dataLocal = this.dataLocal(ev.start.dateTime);
        const faixa = {
          start: this.horaLocal(ev.start.dateTime),
          end: this.horaLocal(ev.end.dateTime),
        };
        mapa.set(dataLocal, [...(mapa.get(dataLocal) || []), faixa]);
      }
      this.ocupados = mapa;
      this.marcarSincronia();
      this.salvar();
    } catch (err) {
      this.conf.lastError = err.message;
      this.salvar();
    }
    return this.ocupados;
  }

  /**
   * Intervalos ocupados no Google para o dia. Quando a conexão está amarrada a
   * um médico, só a agenda dele é bloqueada — o consultório pode ter mais de
   * um profissional e uma conta do Google só.
   */
  ocupadosEm(dateStr, professionalId = null) {
    const c = this.conf;
    if (!this.ativo() || !c.bloquearOcupados) return [];
    if (c.professionalId && professionalId && c.professionalId !== professionalId) return [];
    return this.ocupados.get(dateStr) || [];
  }

  escolherProfissional(id) {
    this.conf.professionalId = String(id || '');
    this.salvar();
    return this.estado();
  }

  dataLocal(iso) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
  }

  horaLocal(iso) {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: this.config.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  }
}

function minutosEntre(inicio, fim) {
  const [h1, m1] = String(inicio).split(':').map(Number);
  const [h2, m2] = String(fim).split(':').map(Number);
  const total = (h2 * 60 + m2) - (h1 * 60 + m1);
  return total > 0 ? total : 30;
}

module.exports = { GoogleCalendar, ErroGoogle, ESCOPO };
