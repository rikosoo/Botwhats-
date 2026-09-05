'use strict';

const { formatDateBr, formatDateLong, formatDateFriendly } = require('./agenda');

/**
 * Todo o texto que o paciente lê está aqui — em um lugar só, para o
 * consultório ajustar o tom sem mexer na lógica.
 *
 * Princípios do tom: conversa de recepção, não menu de URA. Frases curtas,
 * uma pergunta por vez, o nome da pessoa quando conhecido, e nada de
 * "DIGITE 1". Os números aparecem só como atalho de uma lista.
 */

/** Alterna entre variações para a conversa não ficar repetitiva. */
function variar(seed, opcoes) {
  return opcoes[Math.abs(Number(seed) || 0) % opcoes.length];
}

function periodo(hora) {
  if (hora < 12) return 'Bom dia';
  if (hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

const primeiroNome = (contato) => (contato && contato.name ? contato.name.trim().split(/\s+/)[0] : null);

function lista(itens, formatador) {
  return itens.map((item, i) => `${i + 1}. ${formatador(item, i)}`).join('\n');
}

const M = {
  variar,
  primeiroNome,

  saudacao(clinic, contato, hora, aberto, seed = 0) {
    const nome = primeiroNome(contato);
    const abertura = nome
      ? `${periodo(hora)}, ${nome}!`
      : `${periodo(hora)}!`;
    const quem = `Aqui é a ${clinic.assistantName}, assistente do ${clinic.name}`
      + (clinic.specialty ? ` (${clinic.specialty})` : '') + '.';
    const ajuda = variar(seed, [
      'Posso marcar uma consulta, ver seus horários ou tirar dúvidas sobre convênio, endereço e valores. Como posso ajudar?',
      'Consigo agendar, remarcar, confirmar consultas e responder dúvidas de convênio, endereço e valores. O que você precisa hoje?',
      'Me diz o que você precisa: agendar uma consulta, ver um horário já marcado ou tirar uma dúvida. Também posso chamar a secretária.',
    ]);
    const fora = aberto ? '' : `\n\n_Nosso atendimento é ${clinic.hoursText}. Eu sigo por aqui a qualquer hora e a secretária responde assim que abrirmos._`;
    return `${abertura} ${quem}\n\n${ajuda}${fora}`;
  },

  avisoPrivacidade(clinic) {
    return `🔒 ${clinic.policies.privacyNotice}`;
  },

  naoEntendi(clinic, seed = 0) {
    return variar(seed, [
      'Desculpa, não peguei bem o que você quis dizer. 😅 Você quer *agendar*, *remarcar*, *ver sua consulta* ou falar com a *secretária*?',
      'Acho que não entendi direito. Consigo te ajudar a marcar, remarcar ou confirmar uma consulta — ou chamar alguém da equipe. O que faz mais sentido?',
      `Pode reescrever de outro jeito? Posso agendar consulta, informar convênios, endereço e valores do ${clinic.name}, ou passar para a secretária.`,
    ]);
  },

  // ---------- triagem ----------

  emergencia(clinic) {
    return 'Pelo que você escreveu, isso pode ser urgente e eu não consigo avaliar sintomas por aqui. 🚨\n\n'
      + '*Procure atendimento agora*: ligue *192* (SAMU) ou vá ao pronto-socorro mais próximo. '
      + 'Se houver risco imediato, ligue *193* (Bombeiros).\n\n'
      + `Já sinalizei sua mensagem para a equipe do ${clinic.name}. Se for sofrimento emocional, o *CVV* atende no *188*, 24h, gratuito.`;
  },

  atencaoClinica(clinic) {
    return 'Sinto muito que você não esteja bem. 💛 Por aqui eu não consigo avaliar sintomas, '
      + 'mas já avisei a equipe para te retornar com prioridade.\n\n'
      + `Se piorar, ou se aparecer dor forte, falta de ar ou desmaio, procure um pronto-socorro ou ligue *192*. `
      + `Quer que eu já veja o horário mais próximo com ${clinic.professionals[0].name}?`;
  },

  /**
   * Dúvida de quem acabou de ser atendido. Aqui não cabe "marque uma consulta":
   * a pessoa já foi. O caminho é a equipe, e ela precisa saber disso.
   */
  duvidaPosConsulta(clinic) {
    return 'Anotei sua dúvida e já passei para a equipe do consultório — alguém te responde por aqui. 💛\n\n'
      + 'Eu não consigo avaliar orientação de tratamento por mensagem, mas a equipe consegue. '
      + `Se for algo urgente, ligue para ${clinic.phone} ou procure um pronto-socorro.`;
  },

  semConselhoMedico() {
    return 'Essa é uma pergunta para o médico avaliar com você na consulta — por aqui eu cuido só do agendamento, tudo bem? '
      + 'Quer que eu procure um horário?';
  },

  // ---------- agendamento ----------

  perguntarServico(clinic, contato, seed = 0) {
    const nome = primeiroNome(contato);
    const abertura = variar(seed, [
      nome ? `Claro, ${nome}!` : 'Claro!',
      'Perfeito, vamos marcar.',
      'Ótimo, posso cuidar disso agora.',
    ]);
    return `${abertura} O atendimento é:\n\n${lista(clinic.services, (s) => `*${s.name}* — ${s.durationMin} min`)}\n\n`
      + 'Pode responder com o número ou escrever, como preferir.';
  },

  perguntarConvenio(clinic) {
    return `Você vai usar convênio ou particular?\n\n${lista(clinic.insurances, (c) => c)}\n\n`
      + 'Pode escrever o nome do plano, se preferir.';
  },

  convenioNaoAtendido(clinic, nome) {
    return `Poxa, ainda não atendemos ${nome} por convênio. 😕\n\n`
      + `Dá para fazer como particular: ${clinic.privatePrice}. ${clinic.paymentInfo}\n\nQuer seguir assim?`;
  },

  perguntarProfissional(profissionais) {
    return `Com quem você prefere?\n\n${lista(profissionais, (p) => `*${p.name}* — ${p.specialty}`)}\n\n`
      + 'Se tanto faz, me diz "tanto faz" que eu pego o horário mais próximo.';
  },

  perguntarDia(dias, hoje, profissional) {
    const cabecalho = profissional
      ? `Estes são os primeiros dias com ${profissional.name}:`
      : 'Estes são os primeiros dias com vaga:';
    return `${cabecalho}\n\n${lista(dias, (d) => `${formatDateFriendly(d.date, hoje)} — ${d.slots.length} horário(s)`)}\n\n`
      + 'Qual fica melhor para você?';
  },

  perguntarHorario(date, slots, hoje) {
    return `Para ${formatDateFriendly(date, hoje)} eu tenho:\n\n${lista(slots, (s) => `*${s.start}*`)}\n\n`
      + 'Qual horário prefere? (pode escrever "10h", por exemplo)';
  },

  semHorarios(clinic) {
    return 'No momento não encontrei horários livres nos próximos dias. 😕\n\n'
      + `Posso pedir para a secretária te chamar assim que abrir uma vaga — ou você pode ligar para ${clinic.phone}. Quer que eu avise a equipe?`;
  },

  pedirNome() {
    return 'Só preciso de mais dois dados para reservar. Qual é o seu *nome completo*?';
  },

  pedirNascimento(nome) {
    return `Obrigada, ${nome.split(/\s+/)[0]}! E a sua *data de nascimento*? (ex.: 12/05/1980)\n\n`
      + '_Uso só para identificar seu cadastro no consultório._';
  },

  resumoParaConfirmar(clinic, contato, dados, hoje) {
    const linhas = [
      `👤 ${contato.name}`,
      `🩺 ${dados.serviceName} com ${dados.professionalName}`,
      `📅 ${formatDateLong(dados.date)}`,
      `🕒 ${dados.start}`,
      `💳 ${dados.insurance || 'Particular'}`,
    ];
    return `Deixa eu confirmar se anotei tudo certinho:\n\n${linhas.join('\n')}\n\nPosso reservar?`;
  },

  agendamentoConfirmado(clinic, contato, booking, service) {
    const chegue = clinic.policies.arriveMinutes;
    const partes = [
      `Prontinho, ${primeiroNome(contato)}! Sua consulta está reservada. ✅`,
      '',
      `🩺 ${booking.serviceName} com ${booking.professionalName}`,
      `📅 ${formatDateLong(booking.date)} às ${booking.start}`,
      `📍 ${clinic.address}`,
    ];
    if (clinic.addressHint) partes.push(`_${clinic.addressHint}_`);
    partes.push('', `Chegue com ${chegue} minutos de antecedência e traga: ${clinic.documents.join(', ')}.`);
    if (service && service.prep) partes.push(`\n📋 ${service.prep}`);
    partes.push(
      '',
      `Se precisar mudar, me avise por aqui com pelo menos ${clinic.policies.cancelHours}h de antecedência — é só escrever "remarcar" ou "cancelar".`,
    );
    return partes.join('\n');
  },

  avisoLembretes(offsets) {
    return `Vou te lembrar ${offsets.map((d) => (d === 1 ? '1 dia' : `${d} dias`)).join(' e ')} antes, combinado? 🙂`;
  },

  horarioOcupado() {
    return 'Que pena — esse horário acabou de ser reservado por outra pessoa. 😕 Vou te mostrar o que ainda está livre:';
  },

  // ---------- consultas do paciente ----------

  minhasConsultas(bookings, hoje) {
    if (!bookings.length) {
      return 'Não encontrei nenhuma consulta marcada no seu nome. Quer que eu veja os horários disponíveis?';
    }
    const linhas = bookings.map((b) => `📅 ${formatDateFriendly(b.date, hoje)} às ${b.start} — ${b.serviceName} com ${b.professionalName}`
      + (b.confirmation === 'confirmado' ? ' ✅' : ''));
    return `Aqui está o que tenho no seu cadastro:\n\n${linhas.join('\n')}\n\n`
      + 'Quer *confirmar*, *remarcar* ou *cancelar*?';
  },

  presencaConfirmada(booking) {
    return `Presença confirmada para ${formatDateLong(booking.date)} às ${booking.start}. ✅\n\n`
      + 'Até lá! Se surgir qualquer imprevisto, é só me avisar.';
  },

  canceladoComSucesso(clinic, booking) {
    return `Tudo bem, cancelei a consulta de ${formatDateLong(booking.date)} às ${booking.start}. 🗓️\n\n`
      + 'Quer que eu procure outro horário agora?';
  },

  nadaParaCancelar() {
    return 'Não achei nenhuma consulta futura no seu nome para cancelar. Quer marcar uma?';
  },

  remarcando(booking) {
    return `Sem problema — vou liberar o horário de ${formatDateBr(booking.date)} às ${booking.start} e procurar outro para você.`;
  },

  // ---------- informações ----------

  endereco(clinic) {
    const partes = [`📍 ${clinic.address}`];
    if (clinic.addressHint) partes.push(clinic.addressHint);
    if (clinic.mapsUrl) partes.push(`Mapa: ${clinic.mapsUrl}`);
    partes.push(`Atendemos ${clinic.hoursText}. Telefone: ${clinic.phone}.`);
    return partes.join('\n');
  },

  convenios(clinic) {
    const aceitos = clinic.insurances.filter((c) => c.toLowerCase() !== 'particular');
    return `Trabalhamos com: ${aceitos.join(', ')}.\n\nTambém atendemos particular — ${clinic.privatePrice}\n\n`
      + 'Quer que eu já veja um horário?';
  },

  valores(clinic) {
    return `A consulta particular é ${clinic.privatePrice}\n${clinic.paymentInfo}\n\n`
      + 'Se você tem convênio, me diz qual que eu confirmo se atendemos. 🙂';
  },

  documentos(clinic) {
    return `No dia, traga: ${clinic.documents.join(', ')}.\n\n`
      + `E chegue uns ${clinic.policies.arriveMinutes} minutinhos antes para a recepção. 🙂`;
  },

  preparo(clinic) {
    const linhas = clinic.services.filter((s) => s.prep).map((s) => `*${s.name}*: ${s.prep}`);
    return `${linhas.join('\n\n')}\n\nQualquer dúvida sobre o preparo, a secretária confirma com você.`;
  },

  atendente(clinic, aberto) {
    return aberto
      ? `Claro! Já chamei a secretária do ${clinic.name} — ela assume a conversa em instantes. 🙂\n\n`
        + 'Se quiser voltar a falar comigo, é só escrever "menu".'
      : `Certo! Deixei sua mensagem sinalizada para a equipe. Como estamos fora do horário (${clinic.hoursText}), `
        + 'a secretária responde assim que abrirmos.\n\nSe for urgente, ligue *192*.';
  },

  despedida(contato) {
    const nome = primeiroNome(contato);
    return `Foi um prazer${nome ? `, ${nome}` : ''}! Qualquer coisa é só chamar por aqui. Cuide-se. 💛`;
  },

  optOut(clinic) {
    return `Tudo bem, não vou mais enviar lembretes por aqui. 🙏\n\n`
      + `Se precisar marcar alguma coisa, é só mandar uma mensagem ou ligar para ${clinic.phone}.`;
  },

  // ---------- lembretes ----------

  lembreteFollowUp(clinic, contato, dias) {
    const nome = primeiroNome(contato) || 'tudo bem';
    if (dias === 1) {
      return `Oi, ${nome}! Ontem você falou com o ${clinic.name} e não chegamos a marcar. `
        + 'Quer que eu veja os horários desta semana?';
    }
    if (dias === 7) {
      return `Oi, ${nome}! Passando para saber se você ainda quer marcar sua consulta. `
        + 'Se quiser, eu já procuro um horário — é rápido. 🙂';
    }
    return `Oi, ${nome}! Este é meu último lembrete para não te incomodar. `
      + `Se quiser marcar, é só responder por aqui a qualquer momento — ou ligar para ${clinic.phone}. `
      + 'Se preferir não receber mais mensagens, responda "sair".';
  },

  /**
   * Véspera. Não pergunta "confirma?" — mostra o que foi reservado e abre a
   * porta de saída de propósito: quem avisa que não vem devolve o horário a
   * tempo de encaixar outra pessoa.
   */
  lembreteConsulta(clinic, contato, booking, dias, service) {
    const nome = primeiroNome(contato) || 'tudo bem';
    const duracao = service ? service.durationMin : null;
    const reserva = duracao
      ? `${booking.professionalName} reservou ${duracao} minutos só para você`
      : `${booking.professionalName} separou um horário para você`;

    if (dias === 1) {
      const partes = [
        `Oi, ${nome}! Amanhã às ${booking.start} ${reserva}.`,
        '',
        `📍 ${clinic.address}`,
        `Chegue ${clinic.policies.arriveMinutes} min antes e traga ${clinic.documents.slice(0, 2).join(' e ')}.`,
      ];
      if (service && service.prep) partes.push(`📋 ${service.prep}`);
      partes.push(
        '',
        'Se por algum motivo você não conseguir vir, me avisa que a gente encontra um horário melhor '
        + '— assim eu consigo oferecer essa vaga para outra pessoa.',
        'Se estiver tudo certo, é só responder *confirmo*. 🙂',
      );
      return partes.join('\n');
    }

    // Demais toques antes da consulta: utilidade, não cobrança.
    return M.lembreteEspera(clinic, contato, booking, service, `Faltam ${dias} dias`);
  },

  /**
   * Toque no meio da espera. Serve para a consulta não esfriar na agenda do
   * paciente — e entrega algo que adianta o atendimento, em vez de cobrar
   * uma confirmação que ele já deu.
   */
  lembreteEspera(clinic, contato, booking, service, abertura = null) {
    const nome = primeiroNome(contato) || 'tudo bem';
    const quando = `${formatDateLong(booking.date)} às ${booking.start}`;
    const partes = [
      abertura
        ? `Oi, ${nome}! ${abertura} para a sua consulta: ${quando}, com ${booking.professionalName}.`
        : `Oi, ${nome}! Passando para confirmar que está tudo certo com a sua consulta de ${quando}, com ${booking.professionalName}.`,
      '',
      'Se você tiver exames recentes, pode levar no dia — assim '
      + `${booking.professionalName} já avalia tudo e adianta o plano de tratamento.`,
    ];
    if (service && service.prep) partes.push(`📋 ${service.prep}`);
    partes.push('', 'Qualquer imprevisto, me avisa por aqui que eu remarco. 🙂');
    return partes.join('\n');
  },

  /**
   * Um dia depois da consulta. Não pergunta sobre sintomas: pergunta se
   * ficou dúvida nas orientações — e o que vier cai na fila da recepção.
   */
  checkInPosConsulta(clinic, contato) {
    const nome = primeiroNome(contato) || 'tudo bem';
    return `Oi, ${nome}! Passando para saber como você está depois da consulta de ontem. 💛\n\n`
      + 'Ficou alguma dúvida sobre as orientações, ou tem algo em que a gente possa ajudar? '
      + 'Pode escrever por aqui que eu levo para a equipe.';
  },

  lembreteRetorno(clinic, contato, dias) {
    const nome = primeiroNome(contato) || 'tudo bem';
    return `Oi, ${nome}! Já faz ${dias} dias da sua consulta no ${clinic.name}. `
      + `${clinic.professionals[0].name} costuma pedir um retorno neste intervalo. Quer que eu veja um horário?`;
  },

  lembreteFalta(clinic, contato) {
    const nome = primeiroNome(contato) || 'tudo bem';
    return `Oi, ${nome}! Sentimos sua falta na consulta. 💛 Acontece! `
      + 'Quer que eu procure um novo horário para você?';
  },
};

module.exports = M;
