'use strict';

const crypto = require('crypto');

/**
 * Login do painel.
 *
 * O painel mostra nome, telefone, nascimento, convênio e conversa de pacientes:
 * dado de saúde não pode ficar aberto para quem alcançar a porta do servidor.
 *
 * Senha guardada com scrypt e sal por usuário — nunca em texto puro. O que fica
 * gravado da sessão é o hash do token, não o token: quem ler o banco não
 * consegue se passar por alguém logado.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

function gerarHash(senha, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(senha, salt, 64).toString('hex') };
}

function conferirSenha(senha, salt, hash) {
  const esperado = Buffer.from(hash, 'hex');
  const obtido = crypto.scryptSync(senha, salt, 64);
  return esperado.length === obtido.length && crypto.timingSafeEqual(esperado, obtido);
}

const hashDoToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Regras mínimas de senha, explicadas em português para aparecer na tela. */
function validarSenha(senha) {
  if (!senha || senha.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (!/[a-zA-Z]/.test(senha) || !/\d/.test(senha)) return 'Use letras e números na senha.';
  return null;
}

class Auth {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.tentativas = new Map(); // usuário -> { erros, ate }
  }

  get usuarios() {
    return this.store.state.users;
  }

  /** Na primeira execução cria o usuário padrão, marcado para trocar a senha. */
  garantirUsuarioPadrao() {
    if (this.usuarios.length) return null;
    const { username, password } = this.config.admin;
    const { salt, hash } = gerarHash(password);
    const usuario = {
      id: crypto.randomUUID(),
      username,
      salt,
      hash,
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    this.usuarios.push(usuario);
    this.store.commit('user', { id: usuario.id, username });
    console.log(`[login] usuário "${username}" criado com a senha padrão — troque no painel.`);
    return usuario;
  }

  buscarPorUsuario(username) {
    const alvo = String(username || '').trim().toLowerCase();
    return this.usuarios.find((u) => u.username.toLowerCase() === alvo) || null;
  }

  /** Trava tentativas repetidas: força bruta em senha curta é rápida demais. */
  bloqueado(username) {
    const chave = String(username || '').toLowerCase();
    const registro = this.tentativas.get(chave);
    // `ate` zerado é quem só errou algumas vezes: o contador precisa sobreviver
    // até a próxima tentativa, senão a trava nunca fecha.
    if (!registro || !registro.ate) return 0;
    if (registro.ate <= Date.now()) {
      this.tentativas.delete(chave);
      return 0;
    }
    return registro.ate - Date.now();
  }

  registrarErro(username) {
    const chave = String(username || '').toLowerCase();
    const registro = this.tentativas.get(chave) || { erros: 0, ate: 0 };
    registro.erros += 1;
    if (registro.erros >= (this.config.maxLoginAttempts || 8)) {
      registro.ate = Date.now() + 15 * 60000;
      registro.erros = 0;
    }
    this.tentativas.set(chave, registro);
  }

  entrar(username, senha) {
    const espera = this.bloqueado(username);
    if (espera) {
      const minutos = Math.ceil(espera / 60000);
      return { erro: `Muitas tentativas. Tente de novo em ${minutos} minuto(s).` };
    }

    const usuario = this.buscarPorUsuario(username);
    // Mesma mensagem para usuário inexistente e senha errada: não entrega quem existe.
    if (!usuario || !conferirSenha(String(senha || ''), usuario.salt, usuario.hash)) {
      this.registrarErro(username);
      return { erro: 'Usuário ou senha incorretos.' };
    }

    this.tentativas.delete(String(username).toLowerCase());
    usuario.lastLoginAt = new Date().toISOString();

    const token = crypto.randomBytes(32).toString('hex');
    this.store.state.sessions.push({
      tokenHash: hashDoToken(token),
      userId: usuario.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (this.config.sessionDays || 7) * DIA_MS).toISOString(),
    });
    this.limparSessoes();
    this.store.commit('session', null);
    return { token, usuario: this.publico(usuario) };
  }

  usuarioDoToken(token) {
    if (!token) return null;
    const alvo = hashDoToken(token);
    const sessao = this.store.state.sessions.find(
      (s) => s.tokenHash === alvo && new Date(s.expiresAt).getTime() > Date.now(),
    );
    if (!sessao) return null;
    return this.usuarios.find((u) => u.id === sessao.userId) || null;
  }

  sair(token) {
    if (!token) return;
    const alvo = hashDoToken(token);
    this.store.state.sessions = this.store.state.sessions.filter((s) => s.tokenHash !== alvo);
    this.store.commit('session', null);
  }

  limparSessoes() {
    const agora = Date.now();
    this.store.state.sessions = this.store.state.sessions.filter(
      (s) => new Date(s.expiresAt).getTime() > agora,
    );
  }

  /** Troca de senha exige a senha atual — sessão aberta não basta. */
  trocarSenha(usuario, senhaAtual, novaSenha) {
    if (!conferirSenha(String(senhaAtual || ''), usuario.salt, usuario.hash)) {
      return { erro: 'A senha atual não confere.' };
    }
    const problema = validarSenha(novaSenha);
    if (problema) return { erro: problema };
    if (conferirSenha(novaSenha, usuario.salt, usuario.hash)) {
      return { erro: 'A nova senha precisa ser diferente da atual.' };
    }

    const { salt, hash } = gerarHash(novaSenha);
    usuario.salt = salt;
    usuario.hash = hash;
    usuario.mustChangePassword = false;
    usuario.passwordChangedAt = new Date().toISOString();

    // Trocar a senha derruba as outras sessões: é o que se espera de "troquei porque vazou".
    this.store.state.sessions = this.store.state.sessions.filter((s) => s.userId !== usuario.id);
    this.store.commit('user', { id: usuario.id });
    this.store.logEvent('acesso', `Senha de ${usuario.username} alterada`);
    return { ok: true };
  }

  trocarUsuario(usuario, novoNome) {
    const nome = String(novoNome || '').trim();
    if (nome.length < 3) return { erro: 'O nome de usuário precisa ter ao menos 3 caracteres.' };
    const outro = this.buscarPorUsuario(nome);
    if (outro && outro.id !== usuario.id) return { erro: 'Já existe alguém com esse nome de usuário.' };
    usuario.username = nome;
    this.store.commit('user', { id: usuario.id });
    return { ok: true };
  }

  publico(usuario) {
    return {
      id: usuario.id,
      username: usuario.username,
      mustChangePassword: !!usuario.mustChangePassword,
      lastLoginAt: usuario.lastLoginAt,
    };
  }
}

module.exports = { Auth, gerarHash, conferirSenha, validarSenha };
