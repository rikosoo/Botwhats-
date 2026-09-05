'use strict';

/**
 * Canal real, via whatsapp-web.js (WhatsApp Web + QR Code).
 * A biblioteca e opcional: so e carregada quando CHANNEL=whatsapp.
 */
class WhatsAppWebChannel {
  constructor(config) {
    this.name = 'whatsapp';
    this.config = config;
    this.status = 'iniciando';
    this.qr = null;
    this.onMessage = null;
    this.client = null;
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

    const puppeteer = { args: ['--no-sandbox', '--disable-setuid-sandbox'] };
    if (this.config.chromiumPath) puppeteer.executablePath = this.config.chromiumPath;

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
      this.status = 'conectado';
      console.log('[whatsapp] conectado');
    });

    this.client.on('disconnected', (reason) => {
      this.status = `desconectado (${reason})`;
    });

    this.client.on('message', async (msg) => {
      if (!this.onMessage) return;
      if (msg.from.endsWith('@g.us')) return; // ignora grupos
      if (msg.type !== 'chat') return;
      let name = null;
      try {
        const contact = await msg.getContact();
        name = contact.pushname || contact.name || null;
      } catch { /* nome e opcional */ }
      await this.onMessage({ phone: msg.from.replace(/@c\.us$/, ''), name, body: msg.body });
    });

    await this.client.initialize();
  }

  async sendText(phone, text) {
    if (!this.client) throw new Error('Canal do WhatsApp nao iniciado');
    const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
    return this.client.sendMessage(chatId, text);
  }

  async stop() {
    if (this.client) await this.client.destroy();
    this.status = 'desconectado';
  }
}

module.exports = { WhatsAppWebChannel };
