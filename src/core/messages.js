'use strict';

const { formatDateBr, formatDateLong, formatDateFriendly } = require('./agenda');
const { conveniosAtivos, opcoesDePagamento } = require('../clinic');

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

  // ---------- mídia ----------

  /**
   * Áudio, foto e documento. O bot não tenta adivinhar o conteúdo — diz o que
   * consegue fazer e passa para gente de verdade, para o paciente não ficar
   * falando sozinho.
   */
  recebiMidia(clinic, contato, tipo) {
    const nome = primeiroNome(contato);
    const abertura = nome ? `Oi, ${nome}!` : 'Oi!';

    if (tipo === 'audio') {
      return `${abertura} Recebi seu áudio, mas por aqui eu só consigo ler mensagens escritas. 🙏\n\n`
        + 'Já avisei a recepção para ouvir e te responder. Se preferir adiantar, pode me escrever '
        + 'em poucas palavras o que você precisa.';
    }
    if (tipo === 'imagem' || tipo === 'documento') {
      const oque = tipo === 'imagem' ? 'sua foto' : 'seu documento';
      return `${abertura} Recebi ${oque} e já encaminhei para a recepção conferir. 👍\n\n`
        + '_Só um cuidado: evite mandar exames, laudos ou receitas por aqui — esses assuntos são '
        + 'tratados na consulta._';
    }
    if (tipo === 'figurinha') {
      return 'Recebi! 🙂 Se precisar de alguma coisa, é só me escrever.';
    }
    return `${abertura} Recebi seu anexo e passei para a recepção dar uma olhada. 👍\n\n`
      + 'Se puder, me escreve em uma linha o que você precisa que eu já adianto.';
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
    return `Você vai usar convênio ou particular?\n\n${lista(opcoesDePagamento(clinic), (c) => c)}\n\n`
      + 'Pode escrever o nome do plano, se preferir.';
  },

  /** Consultório que só atende particular não faz o paciente adivinhar. */
  somenteParticular(clinic) {
    return `Nós atendemos apenas em regime particular, sem convênio.\n\n`
      + `${clinic.services[0].name}: ${clinic.services[0].price || clinic.privatePrice}. ${clinic.paymentInfo}`;
  },

  /** Plano cadastrado, mas com credenciamento suspenso. */
  convenioSuspenso(clinic, nome) {
    return `No momento não estamos atendendo pela ${nome} — o credenciamento está suspenso. 😕\n\n`
      + `Dá para fazer como particular: ${clinic.privatePrice}. ${clinic.paymentInfo}\n\nQuer seguir assim?`;
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
      + 'Posso te colocar na *lista de espera*: assim que alguém desmarcar, eu te aviso na hora '
      + '— normalmente aparece vaga toda semana. Quer que eu anote seu nome?';
  },

  entrouNaEspera(clinic, posicao) {
    const fila = posicao > 1 ? `Você é a ${posicao}ª pessoa da fila. ` : 'Você é a próxima da fila. ';
    return `Anotado! ✅ ${fila}Assim que abrir um horário eu te aviso por aqui.\n\n`
      + `Se resolver de outro jeito, é só me dizer que eu tiro seu nome. Qualquer urgência, ligue ${clinic.phone}.`;
  },

  jaEstaNaEspera(posicao) {
    return `Você já está na lista de espera${posicao > 1 ? `, na ${posicao}ª posição` : ' e é o próximo da fila'}. `
      + 'Assim que abrir vaga eu te chamo. 🙂';
  },

  saiuDaEspera() {
    return 'Tudo bem, tirei seu nome da lista de espera. Se mudar de ideia, é só me chamar. 🙂';
  },

  /** Vaga que abriu, oferecida a uma pessoa de cada vez. */
  ofertaDeVaga(clinic, contato, vaga, profissional, minutos, hoje) {
    const nome = primeiroNome(contato);
    const quando = `${formatDateFriendly(vaga.date, hoje)} às ${vaga.start}`;
    const prazo = minutos >= 60
      ? `${Math.round(minutos / 60)} hora(s)`
      : `${minutos} minutos`;
    return `${nome ? `${nome}, abriu` : 'Abriu'} uma vaga! 🎉\n\n`
      + `📅 ${quando}${profissional ? ` com ${profissional.name}` : ''}\n\n`
      + `Quer ficar com ela? Responda *sim* nas próximas ${prazo} — depois disso eu preciso oferecer `
      + 'para a próxima pessoa da fila.';
  },

  ofertaExpirada(clinic) {
    return 'A vaga que abriu acabou indo para outra pessoa. 😕\n\n'
      + 'Você continua na lista de espera — na primeira que abrir, eu te chamo de novo.';
  },

  vagaJaFoi() {
    return 'Poxa, essa vaga acabou de ser preenchida. 😕 Você continua na lista e eu te aviso na próxima.';
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
    const aceitos = conveniosAtivos(clinic);
    if (!aceitos.length) return M.somenteParticular(clinic);
    return `Trabalhamos com: ${aceitos.join(', ')}.\n\nTambém atendemos particular — ${clinic.privatePrice}\n\n`
      + 'Quer que eu já veja um horário?';
  },

  /**
   * Preço nunca vai sozinho: quem recebe só o número compara com o do vizinho
   * e decide por ele. Vai o pacote inteiro — duração, o que está incluso,
   * retorno e pagamento — e a conversa termina em dois horários concretos.
   */
  valores(clinic, service = null) {
    const alvo = service || clinic.services[0];
    const linhas = [`*${alvo.name}* — ${alvo.price || clinic.privatePrice}`];

    linhas.push('', 'O que está incluso:');
    linhas.push(`• ${alvo.durationMin} minutos de atendimento com ${clinic.professionals[0].name}`);
    for (const item of alvo.includes || []) linhas.push(`• ${item}`);

    linhas.push('', clinic.paymentInfo);
    const convenios = conveniosAtivos(clinic);
    linhas.push(convenios.length
      ? `Pelo convênio, atendemos ${convenios.join(', ')} — me diz qual é o seu que eu confirmo.`
      : 'Atendemos apenas em regime particular, sem convênio.');
    return linhas.join('\n');
  },

  /** Fecha a conversa de preço com dois horários de verdade, não "temos vaga essa semana". */
  ofertaDeHorarios(slots, hoje) {
    if (!slots.length) return null;
    if (slots.length === 1) {
      const [s] = slots;
      return `Tenho ${formatDateFriendly(s.date, hoje)} às *${s.start}*. Fica bom para você?`;
    }
    const opcoes = slots.slice(0, 2)
      .map((s, i) => `*${i + 1}.* ${formatDateFriendly(s.date, hoje)} às ${s.start}`);
    return `Sobre a agenda, tenho estes dois horários:\n\n${opcoes.join('\n')}\n\n`
      + 'Algum deles serve? Se preferir outro dia, é só dizer.';
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

  lembreteFollowUp(clinic, contato, dias, agendaCheia = false) {
    const nome = primeiroNome(contato) || 'tudo bem';

    // Só falamos em agenda enchendo quando ela está enchendo de verdade.
    if (agendaCheia && dias !== 1) {
      return `Oi, ${nome}! Passando para avisar que as próximas datas do ${clinic.name} estão quase fechando. `
        + 'Se você ainda quer marcar, me diz que eu seguro um horário para você agora. 🙂';
    }

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
        '',
        'Está de pé? Responda *sim* ou *não* que eu já cuido do resto. 🙂',
      );
      return partes.join('\n');
    }

    // Demais toques antes da consulta: utilidade, sem contagem regressiva.
    return M.lembreteEspera(clinic, contato, booking, service);
  },

  /**
   * Toque no meio da espera. Serve para a consulta não esfriar na agenda do
   * paciente — e entrega algo que adianta o atendimento, em vez de cobrar
   * uma confirmação que ele já deu.
   */
  lembreteEspera(clinic, contato, booking, service) {
    const nome = primeiroNome(contato) || 'tudo bem';
    const quando = `${formatDateLong(booking.date)} às ${booking.start}`;
    const partes = [
      `Oi, ${nome}! Sua consulta está marcada para ${quando}, com ${booking.professionalName}.`,
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
