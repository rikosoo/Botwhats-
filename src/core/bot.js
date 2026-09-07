'use strict';

const M = require('./messages');
const nlu = require('./nlu');
const triage = require('./triage');
const {
  findService, findProfessional, conveniosAtivos, convenioSuspenso, opcoesDePagamento,
} = require('../clinic');
const { timeKey, formatDateBr } = require('./agenda');

/** "Tanto faz", em suas várias formas: sempre significa "pegue o primeiro". */
const SEM_PREFERENCIA = /tanto faz|qualquer (um|dia|hora|horario)|indiferente|voce escolhe|o mais (proximo|cedo|rapido)|o quanto antes|o primeiro que tiver|pode ser qualquer/;

/**
 * Autoatendimento do consultório.
 *
 * Regras que valem para tudo o que está aqui:
 *  - o bot agenda, informa e lembra; ele nunca opina sobre sintomas nem conduta;
 *  - sinal de alarme interrompe qualquer fluxo e manda procurar atendimento;
 *  - o paciente pode escrever livremente: número da lista é atalho, não exigência;
 *  - quando o bot não entende duas vezes seguidas, ele chama gente de verdade.
 */
class Bot {
  constructor(store, agenda, reminders, config) {
    this.store = store;
    this.agenda = agenda;
    this.reminders = reminders;
    this.config = config;
  }

  get clinic() {
    return this.store.clinic;
  }

  async handleIncoming({ phone, name, body, mediaType = null, antiga = false }) {
    const contato = this.store.upsertContact(phone, name);
    const primeiraVez = this.store.messagesOf(contato.id).length === 0;
    this.store.addMessage(
      contato.id,
      'in',
      mediaType ? `[${mediaType}]` : body,
      mediaType ? { mediaType } : {},
    );

    // Mensagem que já estava esperando quando o número conectou: responder
    // agora seria responder do nada uma conversa de semanas atrás.
    if (antiga) {
      contato.stage = 'atendimento humano';
      this.store.addNote(contato.id, 'Mensagem recebida antes da conexão — sem resposta automática');
      this.store.logEvent('midia', `Mensagem antiga de ${contato.name || contato.phone} — encaminhada para a recepção`);
      this.store.commit('contact', contato);
      return [];
    }

    // Desligado, o bot não responde nada — mas a mensagem entra no painel e o
    // paciente vai para a fila, senão ninguém percebe que chegou.
    if (this.clinic.botEnabled === false) {
      contato.stage = 'atendimento humano';
      this.store.commit('contact', contato);
      return [];
    }

    /*
     * A recepção já respondeu esta conversa a mão: daqui para frente ela é da
     * pessoa, não do robô. O paciente acabou de falar com alguém — receber a
     * resposta automática por cima desfaz o atendimento e deixa a conversa
     * confusa. Volta ao automático pelo botão "Devolver ao bot" do painel.
     *
     * Repare que isto não é o mesmo que `stage: atendimento humano`, que o
     * próprio bot marca ao encaminhar (urgência, mídia, pedido de atendente) e
     * de onde o paciente ainda consegue voltar sozinho escrevendo "menu".
     */
    if (contato.recepcaoAssumiu && this.clinic.pausarQuandoRecepcaoResponde !== false) {
      this.store.commit('contact', contato);
      return [];
    }

    const respostas = mediaType
      ? this.tratarMidia(contato, mediaType)
      : await this.responder(contato, body, primeiraVez);

    // Enquanto o paciente não marcar, o ciclo de 1/7/15 dias reinicia a cada contato.
    const temConsulta = !!this.agenda.nextBookingOf(contato.id);
    if (!temConsulta && !contato.optOut && contato.stage !== 'atendimento humano') {
      this.reminders.scheduleFollowUps(contato);
    }
    this.store.commit('contact', contato);
    return respostas.filter(Boolean);
  }

  /**
   * Mensagem que não é texto. Figurinha não precisa de gente; áudio, foto e
   * documento precisam — e a conversa vai para a fila da recepção.
   */
  tratarMidia(contato, tipo) {
    const resposta = [M.recebiMidia(this.clinic, contato, tipo)];
    if (tipo === 'figurinha') return resposta;

    contato.stage = 'atendimento humano';
    contato.state = { step: 'atendente', data: contato.state.data || {} };
    this.store.cancelReminders((r) => r.contactId === contato.id && r.kind === 'followup');
    this.store.addNote(contato.id, `Enviou ${tipo} — a recepção precisa abrir a mensagem no WhatsApp`);
    this.store.logEvent('midia', `${contato.name || contato.phone} enviou ${tipo} — encaminhado para a recepção`);
    return resposta;
  }

  // ---------- roteamento ----------

  async responder(contato, body, primeiraVez) {
    const passo = contato.state.step || 'inicio';
    const intencao = nlu.detectarIntencao(body);

    // 1. Segurança vem antes de qualquer fluxo.
    const alarme = triage.avaliar(body);
    if (alarme.nivel === 'emergencia') return this.emergencia(contato, alarme);
    if (alarme.nivel === 'atencao' && passo !== 'agendar_nome') return this.atencao(contato, alarme);

    // 2. Comandos que valem em qualquer ponto da conversa.
    if (intencao === 'sair') return this.sair(contato);
    if (intencao === 'atendente') return this.chamarAtendente(contato);

    if (contato.optOut) {
      contato.optOut = false;
      contato.stage = 'ativo';
    }

    // Depois do handoff o bot fica em silêncio até pedirem "menu".
    if (passo === 'atendente' && intencao !== 'ajuda' && intencao !== 'saudacao') return [];

    // 3. Se há um agendamento em curso, o passo atual tenta entender primeiro:
    //    "unimed" no meio do fluxo é a resposta da pergunta, não uma dúvida solta.
    if (passo === 'espera_confirma') {
      if (intencao === 'sim') return this.entrarNaEspera(contato);
      if (intencao === 'nao') {
        contato.state = { step: 'conversa', data: {} };
        return ['Tudo bem! Se mudar de ideia, é só me chamar. 🙂'];
      }
    }

    if (passo === 'oferta' && !['cancelar', 'remarcar', 'minhas_consultas', 'ajuda', 'atendente'].includes(intencao)) {
      const resposta = this.tratarOferta(contato, body, intencao);
      if (resposta) {
        this.limparErros(contato);
        return resposta;
      }
    }

    if (passo.startsWith('agendar_') && !['cancelar', 'remarcar', 'minhas_consultas', 'ajuda'].includes(intencao)) {
      const resposta = this.tratarPassoDoFluxo(contato, body, intencao, passo);
      if (resposta) {
        this.limparErros(contato);
        return resposta;
      }
    }

    // 4. Intenções gerais.
    if (intencao === 'cancelar') return this.cancelar(contato);
    if (intencao === 'remarcar') return this.remarcar(contato);
    // Vaga oferecida pela lista de espera tem prazo curto: a resposta a ela
    // vem antes de qualquer outra leitura de "sim" ou "não".
    const oferta = this.waitlist && this.waitlist.ofertaAberta(contato.id);
    if (oferta && ['sim', 'nao', 'confirmar_presenca'].includes(intencao)) {
      return intencao === 'nao'
        ? await this.recusarVaga(contato, oferta)
        : this.aceitarVaga(contato, oferta);
    }

    if (intencao === 'lista_espera') return this.entrarNaEspera(contato);
    if (intencao === 'sair_espera') return this.sairDaEspera(contato);
    if (intencao === 'confirmar_presenca') return this.confirmarPresenca(contato);

    // "sim" / "não" logo depois do lembrete de véspera são resposta de
    // presença — não pedido de novo agendamento.
    if (['sim', 'nao'].includes(intencao) && contato.state.step === 'conversa') {
      const pendente = this.consultaAguardandoResposta(contato);
      if (pendente) {
        return intencao === 'sim' ? this.confirmarPresenca(contato) : this.recusarPresenca(contato, pendente);
      }
    }
    if (intencao === 'minhas_consultas') return this.minhasConsultas(contato);
    if (intencao === 'endereco') return this.comAjudaExtra(contato, M.endereco(this.clinic));
    if (intencao === 'convenios') return this.comAjudaExtra(contato, M.convenios(this.clinic));
    if (intencao === 'valores') return this.responderValor(contato, body);
    if (intencao === 'documentos') return this.comAjudaExtra(contato, M.documentos(this.clinic));
    if (intencao === 'preparo') return this.comAjudaExtra(contato, M.preparo(this.clinic));
    if (intencao === 'agendar') return this.iniciarAgendamento(contato, {}, body);
    if (intencao === 'ajuda') return this.saudar(contato, false);

    if (primeiraVez || passo === 'inicio') return this.saudar(contato, primeiraVez);

    // 5. Conversa solta.
    if (intencao === 'saudacao') return this.saudar(contato, false);
    if (intencao === 'agradecimento') return [M.despedida(contato)];
    if (intencao === 'sim') return this.iniciarAgendamento(contato);
    if (intencao === 'nao') return ['Sem problema! Estou por aqui se precisar. 🙂'];
    if (this.pareceDuvidaClinica(body)) return this.duvidaClinica(contato);

    return this.naoEntendi(contato);
  }

  /** Passos do agendamento. Devolve null quando o passo não entendeu a mensagem. */
  tratarPassoDoFluxo(contato, body, intencao, passo) {
    switch (passo) {
      case 'agendar_servico': return this.tratarServico(contato, body);
      case 'agendar_convenio': return this.tratarConvenio(contato, body, intencao);
      case 'agendar_profissional': return this.tratarProfissional(contato, body);
      case 'agendar_dia': return this.tratarDia(contato, body);
      case 'agendar_horario': return this.tratarHorario(contato, body);
      case 'agendar_nome': return this.tratarNome(contato, body, intencao);
      case 'agendar_nascimento': return this.tratarNascimento(contato, body, intencao);
      case 'agendar_confirmar': return this.tratarConfirmacao(contato, body, intencao);
      default: return null;
    }
  }

  /**
   * Dúvida clínica: o bot nunca responde. Quem já foi atendido recentemente vai
   * para a fila da recepção — é a resposta ao check-in do dia seguinte, e ela
   * não pode morrer numa mensagem automática.
   */
  duvidaClinica(contato) {
    if (this.consultouRecentemente(contato)) {
      contato.stage = 'atendimento humano';
      contato.state = { step: 'atendente', data: {} };
      this.store.addNote(contato.id, 'Dúvida após a consulta — aguarda retorno da equipe');
      this.store.logEvent('handoff', `${contato.name || contato.phone} mandou dúvida após a consulta`);
      return [M.duvidaPosConsulta(this.clinic)];
    }
    return [M.semConselhoMedico()];
  }

  /** Esteve na consulta nos últimos dias? */
  consultouRecentemente(contato, dias = 15) {
    const limite = Date.now() - dias * 86400000;
    return this.store.bookingsOf(contato.id).some(
      (b) => b.attendance === 'compareceu' && new Date(b.startsAt).getTime() >= limite,
    );
  }

  /** Perguntas do tipo "posso tomar", "é normal sentir" — o bot não responde, encaminha. */
  pareceDuvidaClinica(body) {
    const t = nlu.normalizar(body);
    return /\b(posso tomar|pode tomar|e normal|é normal|estou sentindo|sinto|dor de|remedio|medicamento|dosagem|efeito colateral|meu exame deu|resultado do exame)\b/.test(t);
  }

  naoEntendi(contato) {
    const erros = (contato.state.data.erros || 0) + 1;
    contato.state.data.erros = erros;
    if (erros >= 3) return this.chamarAtendente(contato);
    return [M.naoEntendi(this.clinic, erros)];
  }

  limparErros(contato) {
    if (contato.state.data) contato.state.data.erros = 0;
  }

  /** Resposta informativa + convite para agendar, sem perder o fio da conversa. */
  comAjudaExtra(contato, texto) {
    this.limparErros(contato);
    if (contato.state.step.startsWith('agendar_')) {
      return [texto, 'Voltando ao agendamento: ' + this.perguntaAtual(contato)];
    }
    contato.state = { step: 'conversa', data: {} };
    return [texto];
  }

  /** Repete a pergunta do passo em que o paciente estava. */
  perguntaAtual(contato) {
    const dados = contato.state.data || {};
    switch (contato.state.step) {
      case 'agendar_servico': return 'é primeira consulta, retorno ou exame?';
      case 'agendar_convenio': return 'você vai usar convênio ou particular?';
      case 'agendar_profissional': return 'com qual profissional você prefere?';
      case 'agendar_dia': return 'qual dia fica melhor?';
      case 'agendar_horario': return `qual horário prefere em ${formatDateBr(dados.date)}?`;
      case 'agendar_nome': return 'qual é o seu nome completo?';
      case 'agendar_nascimento': return 'qual é a sua data de nascimento?';
      case 'agendar_confirmar': return 'posso reservar esse horário?';
      default: return 'como posso ajudar?';
    }
  }

  // ---------- segurança ----------

  emergencia(contato, alarme) {
    contato.priority = 'urgente';
    contato.stage = 'atendimento humano';
    contato.state = { step: 'atendente', data: {} };
    this.store.addNote(contato.id, `Triagem: sinal de alarme ("${alarme.termo}")`);
    // Quem está em situação de risco não recebe mensagem de follow-up.
    this.store.cancelReminders((r) => r.contactId === contato.id && r.kind === 'followup');
    this.store.logEvent('urgencia', `🚨 ${contato.name || contato.phone} relatou "${alarme.termo}" — orientado a procurar atendimento imediato`);
    return [M.emergencia(this.clinic)];
  }

  atencao(contato, alarme) {
    contato.priority = 'atencao';
    this.store.addNote(contato.id, `Triagem: atenção ("${alarme.termo}")`);
    this.store.logEvent('urgencia', `⚠️ ${contato.name || contato.phone} relatou "${alarme.termo}" — priorizar retorno`);
    return [M.atencaoClinica(this.clinic)];
  }

  // ---------- conversa geral ----------

  saudar(contato, primeiraVez) {
    contato.state = { step: 'conversa', data: {} };
    if (contato.stage === 'novo') contato.stage = 'ativo';
    const hora = Number(timeKey(new Date(), this.config.timezone).slice(0, 2));
    const seed = this.store.messagesOf(contato.id).length;
    const respostas = [M.saudacao(this.clinic, contato, hora, this.agenda.isOpenNow(), seed)];

    if (!contato.privacyNoticeSentAt) {
      contato.privacyNoticeSentAt = new Date().toISOString();
      respostas.push(M.avisoPrivacidade(this.clinic));
    }
    if (primeiraVez) this.store.logEvent('saudacao', `Primeiro contato de ${contato.name || contato.phone}`);
    return respostas;
  }

  sair(contato) {
    contato.optOut = true;
    contato.stage = 'opt-out';
    contato.state = { step: 'conversa', data: {} };
    this.store.cancelReminders((r) => r.contactId === contato.id);
    this.store.logEvent('opt-out', `${contato.name || contato.phone} pediu para não receber mais mensagens`);
    return [M.optOut(this.clinic)];
  }

  chamarAtendente(contato) {
    contato.state = { step: 'atendente', data: {} };
    contato.stage = 'atendimento humano';
    // A recepção assume: o bot não fica cobrando por cima do atendimento humano.
    this.store.cancelReminders((r) => r.contactId === contato.id && r.kind === 'followup');
    this.store.logEvent('handoff', `${contato.name || contato.phone} aguarda atendimento humano`);
    return [M.atendente(this.clinic, this.agenda.isOpenNow(), contato)];
  }

  minhasConsultas(contato) {
    this.limparErros(contato);
    const consultas = this.store.bookingsOf(contato.id)
      .filter((b) => b.status === 'confirmado' && new Date(b.startsAt) >= new Date())
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    contato.state = { step: 'conversa', data: {} };
    return [M.minhasConsultas(consultas, this.agenda.today())];
  }

  /** Consulta futura que ainda espera um sim ou não do paciente. */
  consultaAguardandoResposta(contato) {
    const consulta = this.agenda.nextBookingOf(contato.id);
    return consulta && consulta.confirmation !== 'confirmado' ? consulta : null;
  }

  /** "Não vou poder ir": libera cedo é melhor que falta no dia. */
  recusarPresenca(contato, consulta) {
    consulta.confirmation = 'recusado';
    this.store.commit('booking', consulta);
    this.store.logEvent(
      'confirmacao',
      `⚠️ ${contato.name || contato.phone} avisou que não vem em ${formatDateBr(consulta.date)} às ${consulta.start}`,
    );
    contato.state = { step: 'conversa', data: {} };
    return ['Obrigada por avisar! 🙏 Isso ajuda muito — consigo oferecer o horário para outra pessoa.\n\n'
      + 'Quer que eu procure outra data para você, ou prefere cancelar por enquanto?'];
  }

  confirmarPresenca(contato) {
    const consulta = this.agenda.nextBookingOf(contato.id);
    if (!consulta) return this.iniciarAgendamento(contato);
    consulta.confirmation = 'confirmado';
    consulta.confirmedAt = new Date().toISOString();
    this.store.commit('booking', consulta);
    this.store.logEvent('confirmacao', `${contato.name || contato.phone} confirmou presença em ${formatDateBr(consulta.date)} às ${consulta.start}`);
    return [M.presencaConfirmada(consulta)];
  }

  cancelar(contato) {
    const consulta = this.agenda.nextBookingOf(contato.id);
    if (!consulta) {
      contato.state = { step: 'conversa', data: {} };
      return [M.nadaParaCancelar()];
    }
    this.agenda.cancel(consulta.id, 'cancelado pelo paciente');
    contato.stage = 'ativo';
    contato.state = { step: 'conversa', data: {} };
    this.reminders.scheduleFollowUps(contato);
    this.store.logEvent('cancelamento', `${contato.name || contato.phone} cancelou ${formatDateBr(consulta.date)} às ${consulta.start}`);
    return [M.canceladoComSucesso(this.clinic, consulta)];
  }

  remarcar(contato) {
    const consulta = this.agenda.nextBookingOf(contato.id);
    if (!consulta) return this.iniciarAgendamento(contato);
    this.agenda.cancel(consulta.id, 'remarcado pelo paciente');
    this.store.logEvent('remarcacao', `${contato.name || contato.phone} pediu para remarcar ${formatDateBr(consulta.date)} às ${consulta.start}`);
    const abertura = M.remarcando(consulta);
    const proximo = this.iniciarAgendamento(contato, { serviceId: consulta.serviceId, insurance: consulta.insurance });
    return [abertura, ...proximo];
  }

  // ---------- lista de espera ----------

  entrarNaEspera(contato) {
    if (!this.waitlist) return [M.semHorarios(this.clinic, contato)];
    const jaEstava = this.waitlist.entradasDe(contato.id)[0];
    if (jaEstava) {
      contato.state = { step: 'conversa', data: {} };
      return [M.jaEstaNaEspera(this.waitlist.posicao(jaEstava))];
    }

    const dados = contato.state.data || {};
    const entrada = this.waitlist.adicionar(contato.id, {
      serviceId: dados.serviceId || null,
      professionalId: dados.professionalId || null,
    });
    contato.stage = 'na espera';
    contato.state = { step: 'conversa', data: {} };
    return [M.entrouNaEspera(this.clinic, this.waitlist.posicao(entrada))];
  }

  sairDaEspera(contato) {
    const entrada = this.waitlist && this.waitlist.entradasDe(contato.id)[0];
    contato.state = { step: 'conversa', data: {} };
    if (!entrada) return ['Você não está na lista de espera no momento. Quer que eu procure um horário?'];
    this.waitlist.remover(entrada.id, 'removido');
    if (contato.stage === 'na espera') contato.stage = 'ativo';
    this.store.logEvent('espera', `${contato.name || contato.phone} saiu da lista de espera`);
    return [M.saiuDaEspera()];
  }

  /** Aceitou a vaga oferecida: reserva na hora, pedindo só o que falta no cadastro. */
  aceitarVaga(contato, entrada) {
    const vaga = entrada.offer;
    const service = findService(this.clinic, vaga.serviceId);
    if (!this.agenda.isSlotFree(vaga.date, vaga.start, {
      professionalId: vaga.professionalId, serviceId: service.id,
    })) {
      this.waitlist.recusar(entrada);
      return [M.vagaJaFoi()];
    }

    contato.state = {
      step: 'agendar_confirmar',
      data: {
        serviceId: service.id,
        professionalId: vaga.professionalId,
        date: vaga.date,
        start: vaga.start,
        insurance: contato.insurance,
        entradaEsperaId: entrada.id,
      },
    };
    if (!contato.name) {
      contato.state.step = 'agendar_nome';
      return [M.pedirNome()];
    }
    if (!contato.birthDate) {
      contato.state.step = 'agendar_nascimento';
      return [M.pedirNascimento(contato.name)];
    }
    return this.tratarConfirmacao(contato, 'sim', 'sim');
  }

  async recusarVaga(contato, entrada) {
    await this.waitlist.recusar(entrada);
    contato.state = { step: 'conversa', data: {} };
    return ['Sem problema! Continuo com seu nome na lista e te aviso na próxima vaga. 🙂'];
  }

  // ---------- fluxo de agendamento ----------

  /** Reconhece o tipo de atendimento pelo que a pessoa escreveu ("é um retorno"). */
  inferirServico(texto) {
    const t = nlu.normalizar(texto);
    const porNome = this.clinic.services.find(
      (s) => t.includes(nlu.normalizar(s.name).split(' ')[0]),
    );
    if (porNome) return porNome;
    if (/primeira vez|nunca vim|nunca consultei|novo paciente/.test(t)) return findService(this.clinic, 'primeira-consulta');
    if (/revisao|ja sou paciente|ja consultei|mostrar exames/.test(t)) return findService(this.clinic, 'retorno');
    if (/procedimento|coleta|ultrassom|eletro/.test(t)) return findService(this.clinic, 'exame');
    return null;
  }

  iniciarAgendamento(contato, prefill = {}, body = '') {
    this.limparErros(contato);
    contato.state = { step: 'agendar_servico', data: { ...prefill, erros: 0 } };
    const servico = prefill.serviceId ? findService(this.clinic, prefill.serviceId) : this.inferirServico(body);
    if (servico) return this.definirServico(contato, servico.id);
    return [M.perguntarServico(this.clinic, contato, this.store.messagesOf(contato.id).length)];
  }

  definirServico(contato, serviceId) {
    const service = findService(this.clinic, serviceId);
    contato.state.data.serviceId = service.id;
    contato.state.data.serviceName = service.name;
    if (contato.state.data.insurance) return this.perguntarProfissional(contato);

    // Só particular: não faz sentido perguntar o convênio.
    if (!conveniosAtivos(this.clinic).length) {
      contato.state.data.insurance = 'Particular';
      return this.perguntarProfissional(contato);
    }
    contato.state.step = 'agendar_convenio';
    return [M.perguntarConvenio(this.clinic)];
  }

  tratarServico(contato, body) {
    const numero = nlu.lerNumero(body, this.clinic.services.length);
    const service = numero ? this.clinic.services[numero - 1] : this.inferirServico(body);
    if (!service) return null;
    return this.definirServico(contato, service.id);
  }

  tratarConvenio(contato, body, intencao) {
    const texto = nlu.normalizar(body);
    const dados = contato.state.data;

    if (dados.aguardandoParticular) {
      dados.aguardandoParticular = false;
      if (intencao === 'nao') {
        contato.state = { step: 'conversa', data: {} };
        return ['Tudo bem! Se mudar de ideia ou quiser confirmar com a secretária, é só me chamar. 🙂'];
      }
      dados.insurance = 'Particular';
      return this.perguntarProfissional(contato);
    }

    const opcoes = opcoesDePagamento(this.clinic);
    const numero = nlu.lerNumero(body, opcoes.length);
    if (numero) {
      dados.insurance = opcoes[numero - 1];
      return this.perguntarProfissional(contato);
    }

    if (/particular|sem convenio|nao tenho plano/.test(texto)) {
      dados.insurance = 'Particular';
      return this.perguntarProfissional(contato);
    }

    const aceito = nlu.lerConvenio(body, opcoes);
    if (aceito) {
      dados.insurance = aceito;
      return this.perguntarProfissional(contato);
    }

    // Plano cadastrado, mas com credenciamento suspenso: a resposta é outra.
    const suspenso = (this.clinic.insurances || [])
      .map((c) => (typeof c === 'string' ? c : c.name))
      .find((nome) => texto.includes(nlu.normalizar(nome)) && convenioSuspenso(this.clinic, nome));
    if (suspenso) {
      dados.aguardandoParticular = true;
      return [M.convenioSuspenso(this.clinic, suspenso)];
    }

    // Citou um plano que não atendemos: oferece particular em vez de travar.
    if (/\b(convenio|plano|carteirinha)\b/.test(texto) || texto.split(' ').length <= 3) {
      dados.aguardandoParticular = true;
      return [M.convenioNaoAtendido(this.clinic, body.trim())];
    }
    return null;
  }

  /**
   * Pergunta de preço. Responde o pacote inteiro e termina em dois horários
   * concretos — quem recebe só o número compara preço e some.
   */
  responderValor(contato, body) {
    this.limparErros(contato);
    const servico = this.inferirServico(body) || findService(this.clinic, contato.state.data.serviceId);
    const resposta = [M.valores(this.clinic, servico)];

    // Se já está agendando, não atropela o passo em que a pessoa estava.
    if (contato.state.step.startsWith('agendar_')) {
      resposta.push(`Voltando ao agendamento: ${this.perguntaAtual(contato)}`);
      return resposta;
    }

    const { professionalId, dias } = this.buscarDias({ serviceId: servico.id }, 2);
    // Um horário por dia: duas opções em dias diferentes ajudam mais a decidir
    // do que dois horários colados na mesma manhã.
    const slots = dias.map((d) => d.slots[0]).filter(Boolean);
    if (slots.length < 2 && dias[0] && dias[0].slots[1]) slots.push(dias[0].slots[1]);
    const oferta = M.ofertaDeHorarios(slots, this.agenda.today());
    if (!oferta) {
      contato.state = { step: 'conversa', data: {} };
      return resposta;
    }

    resposta.push(oferta);
    contato.state = {
      step: 'oferta',
      data: {
        serviceId: servico.id,
        professionalId,
        opcoes: slots.map((s) => ({ date: s.date, start: s.start, professionalId: s.professionalId })),
      },
    };
    return resposta;
  }

  /** Resposta aos dois horários oferecidos junto com o valor. */
  tratarOferta(contato, body, intencao) {
    const opcoes = contato.state.data.opcoes || [];
    const numero = nlu.lerNumero(body, opcoes.length);
    let escolhida = numero ? opcoes[numero - 1] : null;
    if (!escolhida) {
      const horario = nlu.lerHorario(body, opcoes.map((o) => o.start));
      escolhida = opcoes.find((o) => o.start === horario) || null;
    }

    if (escolhida) {
      contato.state.data.date = escolhida.date;
      contato.state.data.start = escolhida.start;
      contato.state.data.professionalId = escolhida.professionalId;
      if (!contato.name) {
        contato.state.step = 'agendar_nome';
        return [M.pedirNome()];
      }
      if (!contato.birthDate) {
        contato.state.step = 'agendar_nascimento';
        return [M.pedirNascimento(contato.name)];
      }
      return this.mostrarResumo(contato);
    }

    // Não serviu nenhum dos dois: volta para a escolha normal de dia.
    if (intencao === 'nao' || /outro|outra data|nenhum|nao da|nao posso/.test(nlu.normalizar(body))) {
      return this.iniciarAgendamento(contato, { serviceId: contato.state.data.serviceId });
    }
    if (intencao === 'sim') return this.iniciarAgendamento(contato, { serviceId: contato.state.data.serviceId });
    return null;
  }

  perguntarProfissional(contato) {
    this.limparErros(contato);
    const disponiveis = this.agenda.professionalsFor(contato.state.data.serviceId);
    if (disponiveis.length === 1) {
      contato.state.data.professionalId = disponiveis[0].id;
      return this.perguntarDia(contato);
    }
    contato.state.step = 'agendar_profissional';
    contato.state.data.opcoesProfissionais = disponiveis.map((p) => p.id);
    return [M.perguntarProfissional(disponiveis)];
  }

  tratarProfissional(contato, body) {
    const ids = contato.state.data.opcoesProfissionais || [];
    const texto = nlu.normalizar(body);
    if (SEM_PREFERENCIA.test(texto)) {
      contato.state.data.professionalId = null; // usa o primeiro com vaga
      return this.perguntarDia(contato);
    }
    const numero = nlu.lerNumero(body, ids.length);
    let escolhido = numero ? ids[numero - 1] : null;
    if (!escolhido) {
      const achado = this.clinic.professionals.find((p) => {
        const partes = nlu.normalizar(p.name).split(' ').filter((w) => w.length > 3);
        return partes.some((w) => texto.includes(w)) || texto.includes(nlu.normalizar(p.specialty));
      });
      escolhido = achado ? achado.id : null;
    }
    if (!escolhido) return null;
    contato.state.data.professionalId = escolhido;
    return this.perguntarDia(contato);
  }

  /** Opções de agendamento para o serviço/profissional escolhidos. */
  buscarDias({ serviceId, professionalId }, limite = 4) {
    if (professionalId) {
      return { professionalId, dias: this.agenda.nextAvailableDays(limite, { professionalId, serviceId }) };
    }
    // "Tanto faz": pega o profissional com a agenda mais próxima.
    let melhor = null;
    for (const p of this.agenda.professionalsFor(serviceId)) {
      const dias = this.agenda.nextAvailableDays(limite, { professionalId: p.id, serviceId });
      if (!dias.length) continue;
      if (!melhor || dias[0].date < melhor.dias[0].date) melhor = { professionalId: p.id, dias };
    }
    return melhor || { professionalId: null, dias: [] };
  }

  perguntarDia(contato) {
    const { professionalId, dias } = this.buscarDias(contato.state.data);
    if (!dias.length) {
      // Sem vaga não é fim de conversa: é entrada para a lista de espera.
      contato.state = {
        step: 'espera_confirma',
        data: { serviceId: contato.state.data.serviceId, professionalId: contato.state.data.professionalId },
      };
      this.store.logEvent('agenda', `Sem horários para ${contato.name || contato.phone}`);
      return [M.semHorarios(this.clinic, contato)];
    }
    contato.state.data.professionalId = professionalId;
    contato.state.step = 'agendar_dia';
    contato.state.data.opcoesDias = dias.map((d) => d.date);
    const profissional = findProfessional(this.clinic, professionalId);
    return [M.perguntarDia(dias, this.agenda.today(), profissional)];
  }

  tratarDia(contato, body) {
    const dias = contato.state.data.opcoesDias || [];
    const texto = nlu.normalizar(body);
    const numero = nlu.lerNumero(body, dias.length);
    let escolhido = numero ? dias[numero - 1] : null;

    // "Tanto faz" aqui quer dizer "o mais cedo possível", não confusão.
    if (!escolhido && SEM_PREFERENCIA.test(texto)) [escolhido] = dias;

    if (!escolhido && /amanha/.test(texto)) {
      const { addDaysToKey } = require('./agenda');
      const amanha = addDaysToKey(this.agenda.today(), 1);
      escolhido = dias.includes(amanha) ? amanha : null;
    }
    if (!escolhido && /hoje/.test(texto)) escolhido = dias.includes(this.agenda.today()) ? this.agenda.today() : null;
    if (!escolhido) {
      const dia = texto.match(/\b(\d{1,2})[/-](\d{1,2})\b/);
      if (dia) {
        const alvo = `${dia[1].padStart(2, '0')}/${dia[2].padStart(2, '0')}`;
        escolhido = dias.find((d) => formatDateBr(d).startsWith(alvo)) || null;
      }
    }
    if (!escolhido) {
      const semana = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
      const idx = semana.findIndex((nome) => texto.includes(nome));
      if (idx >= 0) {
        const { weekdayOf } = require('./agenda');
        escolhido = dias.find((d) => weekdayOf(d) === idx) || null;
      }
    }
    if (!escolhido) return null;

    const slots = this.agenda.slotsFor(escolhido, {
      professionalId: contato.state.data.professionalId,
      serviceId: contato.state.data.serviceId,
    });
    if (!slots.length) return this.perguntarDia(contato);

    const oferecidos = slots.slice(0, 8);
    contato.state.step = 'agendar_horario';
    contato.state.data.date = escolhido;
    contato.state.data.opcoesHorarios = oferecidos.map((s) => s.start);
    return [M.perguntarHorario(escolhido, oferecidos, this.agenda.today())];
  }

  tratarHorario(contato, body) {
    const horarios = contato.state.data.opcoesHorarios || [];
    const numero = nlu.lerNumero(body, horarios.length);
    let escolhido = numero ? horarios[numero - 1] : null;
    if (!escolhido && SEM_PREFERENCIA.test(nlu.normalizar(body))) [escolhido] = horarios;
    if (!escolhido) {
      const candidatos = nlu.lerHorarioCandidatos(body, horarios);
      if (candidatos.length === 1) [escolhido] = candidatos;
      // "9h" com 09:00, 09:20 e 09:40 livres: pergunta em vez de chutar.
      if (candidatos.length > 1) {
        return [`Nesse horário eu tenho ${candidatos.join(', ')}. Qual delas fica melhor?`];
      }
    }
    if (!escolhido) return null;

    contato.state.data.start = escolhido;
    if (!contato.name) {
      contato.state.step = 'agendar_nome';
      return [M.pedirNome()];
    }
    if (!contato.birthDate) {
      contato.state.step = 'agendar_nascimento';
      return [M.pedirNascimento(contato.name)];
    }
    return this.mostrarResumo(contato);
  }

  tratarNome(contato, body, intencao) {
    if (intencao && !['sim', 'nao', 'saudacao'].includes(intencao)) return null;
    if (!nlu.pareceNome(body)) {
      return ['Preciso do nome completo para o cadastro (nome e sobrenome). Como você se chama?'];
    }
    contato.name = body.trim().replace(/\s+/g, ' ');
    contato.state.step = 'agendar_nascimento';
    return [M.pedirNascimento(contato.name)];
  }

  tratarNascimento(contato, body, intencao) {
    if (intencao && !['sim', 'nao'].includes(intencao)) return null;
    const data = nlu.lerDataNascimento(body);
    if (!data) return ['Pode me mandar a data de nascimento no formato dia/mês/ano? Ex.: 12/05/1980.'];
    contato.birthDate = data;
    return this.mostrarResumo(contato);
  }

  mostrarResumo(contato) {
    const dados = contato.state.data;
    const profissional = findProfessional(this.clinic, dados.professionalId) || this.clinic.professionals[0];
    dados.professionalName = profissional.name;
    dados.serviceName = findService(this.clinic, dados.serviceId).name;
    contato.state.step = 'agendar_confirmar';
    return [M.resumoParaConfirmar(this.clinic, contato, dados, this.agenda.today())];
  }

  tratarConfirmacao(contato, body, intencao) {
    if (intencao === 'nao') return this.perguntarDia(contato);
    if (intencao !== 'sim' && intencao !== 'confirmar_presenca') {
      return ['Só para eu ter certeza: posso reservar esse horário? (responda *sim* ou *não*)'];
    }

    const dados = contato.state.data;
    let consulta;
    try {
      consulta = this.agenda.book(contato.id, {
        professionalId: dados.professionalId,
        serviceId: dados.serviceId,
        date: dados.date,
        start: dados.start,
        insurance: dados.insurance,
      });
    } catch {
      return [M.horarioOcupado(), ...this.perguntarDia(contato)];
    }

    contato.stage = 'agendado';
    contato.insurance = dados.insurance || contato.insurance;
    if (dados.entradaEsperaId && this.waitlist) {
      const entrada = this.store.state.waitlist.find((e) => e.id === dados.entradaEsperaId);
      if (entrada) this.waitlist.aceitar(entrada);
    }
    contato.state = { step: 'conversa', data: {} };
    this.store.cancelReminders((r) => r.contactId === contato.id && r.kind === 'followup');
    const criados = this.reminders.scheduleBookingReminders(consulta);
    this.store.logEvent(
      'agendamento',
      `${contato.name} marcou ${consulta.serviceName} com ${consulta.professionalName} em ${formatDateBr(consulta.date)} às ${consulta.start}`,
    );

    const service = findService(this.clinic, consulta.serviceId);
    const respostas = [M.agendamentoConfirmado(this.clinic, contato, consulta, service)];
    if (criados.length) respostas.push(M.avisoLembretes(criados.map((r) => r.offsetDays)));
    return respostas;
  }
}

module.exports = { Bot };
