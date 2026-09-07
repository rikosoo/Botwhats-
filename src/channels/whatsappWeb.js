'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Canal real, via whatsapp-web.js (WhatsApp Web + QR Code).
 * A biblioteca e opcional: so e carregada quando CHANNEL=whatsapp.
 */
/**
 * Como cada tipo de mensagem do WhatsApp e apresentado no painel.
 * O conteudo em si nao e baixado: audio e imagem de paciente podem carregar
 * dado clinico, e o consultorio nao precisa de copia disso no servidor.
 */
/*
 * O horario de uma mensagem vem do aparelho de quem escreveu. Relogio de
 * celular atrasa alguns minutos sem ninguem notar, e uma mensagem nova pareceria
 * anterior a conexao — e ficaria sem resposta. Dois minutos de folga cobrem o
 * desvio comum sem deixar a fila acumulada passar.
 */
const TOLERANCIA_DE_RELOGIO_MS = 2 * 60000;

const TIPOS_DE_MIDIA = {
  ptt: 'audio',
  audio: 'audio',
  image: 'imagem',
  video: 'video',
  document: 'documento',
  sticker: 'figurinha',
  location: 'localizacao',
  vcard: 'contato',
  multi_vcard: 'contato',
};

/**
 * O Chrome escreve em $HOME assim que abre (cache, crashpad, mimeapps).
 * Num servico endurecido, /home costuma estar somente-leitura e ele nem sobe —
 * o erro aparece como "mkdir: Read-only file system" e o QR nunca chega.
 * Por isso apontamos um HOME proprio, gravavel, dentro do projeto.
 */
function prepararHomeDoChrome() {
  const candidatos = [
    path.join(__dirname, '..', '..', '.chrome-home'),
    path.join(os.tmpdir(), 'botwhats-chrome-home'),
  ];
  for (const base of candidatos) {
    try {
      for (const sub of ['.local/share/applications', '.config', '.cache']) {
        fs.mkdirSync(path.join(base, sub), { recursive: true });
      }
      fs.accessSync(base, fs.constants.W_OK);
      return base;
    } catch { /* tenta o proximo */ }
  }
  return null;
}

class WhatsAppWebChannel {
  constructor(config) {
    this.name = 'whatsapp';
    this.config = config;
    this.status = 'iniciando';
    this.qr = null;
    this.onMessage = null;
    this.client = null;
    this.pronto = false;
    this.conectadoEm = null;
    // Fim da janela de silencio pos-conexao (ms). Fica no objeto para o painel
    // poder mostrar quanto falta e para a recepcao poder encerrar antes.
    this.silencioAte = null;
  }

  /** O painel manda o valor atual; o .env fica como padrao de partida. */
  definirJanelaDeSilencio(fn) {
    this.janelaFn = fn;
  }

  janelaDeSilencioMs() {
    if (this.janelaFn) {
      const doPainel = Number(this.janelaFn());
      if (Number.isFinite(doPainel) && doPainel >= 0) return doPainel;
    }
    const segundos = Number(this.config.connectQuietSeconds);
    return (Number.isFinite(segundos) && segundos >= 0 ? segundos : 300) * 1000;
  }

  /** Ainda estamos no silencio que se segue a conexao? */
  emSilencio(agora = Date.now()) {
    return this.silencioAte !== null && agora < this.silencioAte;
  }

  /** Quanto falta do silencio, em segundos (0 quando acabou). */
  silencioRestante(agora = Date.now()) {
    if (!this.emSilencio(agora)) return 0;
    return Math.ceil((this.silencioAte - agora) / 1000);
  }

  /** A recepcao conferiu a fila e quer o bot respondendo ja. */
  encerrarSilencio() {
    this.silencioAte = null;
  }

  /**
   * Esta mensagem merece resposta automatica?
   *
   * Ao conectar, o WhatsApp entrega tudo o que chegou enquanto o numero esteve
   * offline — e nao entrega de uma vez, entrega em levas que podem levar
   * minutos. Sem estas travas, ligar o aparelho vira uma rajada de respostas
   * para conversas de dias atras. O que e barrado aqui continua registrado no
   * painel e vai para a fila da recepcao; so a resposta automatica e que nao
   * sai.
   */
  classificar(quando, agora = Date.now()) {
    // 1. A leva ainda esta chegando. Nada e respondido nesta janela.
    if (this.emSilencio(agora)) {
      return { antiga: true, motivo: 'silencio pos-conexao' };
    }
    // 2. Escrita antes de o numero conectar: e fila, por mais recente que
    //    pareca. A folga cobre o relogio atrasado do aparelho de quem enviou.
    if (quando > 0 && this.conectadoEm !== null
        && quando < this.conectadoEm - TOLERANCIA_DE_RELOGIO_MS) {
      return { antiga: true, motivo: 'anterior a conexao' };
    }
    // 3. Rede de seguranca: mensagem velha demais, venha de onde vier.
    const limite = (this.config.ignoreOlderThanMinutes || 10) * 60000;
    if (quando > 0 && agora - quando > limite) {
      return { antiga: true, motivo: 'mensagem antiga' };
    }
    return { antiga: false, motivo: null };
  }

  async start() {
    let wweb;
    try {
      wweb = require('whatsapp-web.js');
    } catch {
      throw new Error(
        'Dependencia ausente: rode "npm install whatsapp-web.js qrcode-terminal" para usar CHANNEL=whatsapp',
      );
    }
    const { Client, LocalAuth } = wweb;

    const puppeteer = {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // /dev/shm e minusculo em instancia pequena; sem isto o Chrome trava
        // ao abrir e o QR nunca chega.
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
      ],
      timeout: 120000,
    };
    if (this.config.chromiumPath) puppeteer.executablePath = this.config.chromiumPath;

    const home = prepararHomeDoChrome();
    if (home) {
      puppeteer.env = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
      };
    }

    this.client = new Client({ authStrategy: new LocalAuth(), puppeteer });

    this.client.on('qr', (qr) => {
      this.qr = qr;
      this.status = 'aguardando leitura do QR Code';
      try {
        require('qrcode-terminal').generate(qr, { small: true });
      } catch {
        console.log('[whatsapp] QR Code (instale qrcode-terminal para ver o desenho):', qr);
      }
    });

    this.client.on('ready', () => {
      this.qr = null;
      this.pronto = true;
      this.conectadoEm = Date.now();
      this.silencioAte = this.conectadoEm + this.janelaDeSilencioMs();
      this.status = 'conectado';
      const minutos = Math.round(this.janelaDeSilencioMs() / 60000);
      console.log(`[whatsapp] conectado — sem resposta automatica nos proximos ${minutos} min`);
    });

    this.client.on('disconnected', (reason) => {
      this.pronto = false;
      this.silencioAte = null;
      this.status = `desconectado (${reason})`;
    });

    this.client.on('auth_failure', (msg) => {
      this.pronto = false;
      this.status = `falha na autenticacao (${msg})`;
    });

    this.client.on('message', async (msg) => {
      if (!this.onMessage) return;
      if (msg.from.endsWith('@g.us')) return;            // grupos
      if (msg.from === 'status@broadcast' || msg.isStatus) return; // status

      /*
       * Ao conectar, o WhatsApp entrega tudo o que chegou enquanto o numero
       * esteve offline — inclusive conversas de semanas atras. Sem esta
       * checagem o bot responde todas de uma vez, e o paciente recebe do nada
       * uma resposta para uma mensagem antiga.
       *
       * Mensagem velha e registrada no painel e mandada para a fila da
       * recepcao, mas nao recebe resposta automatica.
       */
      const { antiga, motivo } = this.classificar(Number(msg.timestamp || 0) * 1000);
      if (antiga) console.log(`[whatsapp] sem resposta automatica (${motivo}) para ${msg.from}`);

      // Audio, foto e documento nao podem cair no vazio: o paciente acha que
      // falou com o consultorio e ninguem respondeu.
      const mediaType = msg.type === 'chat' ? null : (TIPOS_DE_MIDIA[msg.type] || 'anexo');

      let name = null;
      try {
        const contact = await msg.getContact();
        name = contact.pushname || contact.name || null;
      } catch { /* nome e opcional */ }

      await this.onMessage({
        phone: msg.from.replace(/@c\.us$/, ''),
        name,
        body: msg.body || '',
        mediaType,
        antiga,
      });
    });

    try {
      await this.client.initialize();
    } catch (err) {
      // Falhar calado deixa o painel esperando um QR que nunca vem.
      this.status = `erro ao iniciar: ${err.message}`;
      throw err;
    }
  }

  async sendText(phone, text) {
    if (!this.client) throw new Error('Canal do WhatsApp nao iniciado');
    // Sem esta checagem, a biblioteca estoura com "Cannot read properties of
    // undefined (reading 'getChat')" — mensagem que nao ajuda ninguem.
    if (!this.pronto) {
      throw new Error('WhatsApp ainda nao conectado — leia o QR Code em Ajustes > Conexao do WhatsApp');
    }
    const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
    return this.client.sendMessage(chatId, text);
  }

  /**
   * Desvincula o aparelho e volta a pedir QR Code — usado para trocar de numero.
   * O logout apaga a sessao salva; sem reiniciar o cliente, nao viria QR novo.
   */
  async logout() {
    if (!this.client) throw new Error('Canal do WhatsApp nao iniciado');
    this.status = 'desconectando';
    this.qr = null;
    try {
      await this.client.logout();
    } catch {
      await this.client.destroy();
    }
    this.pronto = false;
    this.status = 'aguardando leitura do QR Code';
    await this.client.initialize();
  }

  async stop() {
    if (this.client) await this.client.destroy();
    this.status = 'desconectado';
  }
}

module.exports = { WhatsAppWebChannel, TIPOS_DE_MIDIA };
