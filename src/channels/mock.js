'use strict';

/**
 * Canal de simulacao: nao fala com o WhatsApp de verdade.
 * As mensagens entram pelo simulador do painel e as respostas ficam
 * registradas no historico, o que permite testar todo o fluxo sem celular.
 */
class MockChannel {
  constructor() {
    this.name = 'mock';
    this.status = 'conectado';
    this.qr = null;
    this.onMessage = null;
  }

  async start() {
    this.status = 'conectado';
  }

  async sendText() {
    return { ok: true };
  }

  async stop() {
    this.status = 'desconectado';
  }
}

module.exports = { MockChannel };
