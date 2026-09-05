# Backlog — ideias para as próximas versões

Anotações vindas de conteúdo sobre captação e follow-up em consultório, traduzidas para onde
cada uma encaixa neste código. Nada aqui está implementado ainda.

Ordem sugerida: 1 → 2 → 6 → 3 → 4 → 5 (do mais barato e mais útil para o mais trabalhoso).

---

## 1. Confirmação que mostra o que foi reservado, em vez de "confirma?"

**Ideia.** Perguntar "confirma?" faz o paciente responder "confirmo" no automático, sem abrir a
agenda dele. O que funciona é mostrar o que foi reservado **e abrir a porta de saída**:

> "Oi, [nome]! Amanhã às 14h a Dra. reservou 40 minutos só para você. Se por algum motivo não
> conseguir vir, a gente encontra um horário melhor."

Dar permissão para desmarcar parece perda, mas devolve o horário a tempo de encaixar outro paciente.

**Onde entra.** `src/core/messages.js` → `lembreteConsulta(...)`, ramo `dias === 1`. Hoje termina em
*"Você confirma sua presença?"* — trocar pela versão que cita a duração reservada
(`service.durationMin`, já disponível) e convida a remarcar sem culpa.

**Esforço.** Pequeno: uma mensagem. Um teste em `test/reminders.test.js` para garantir que o texto
cita a duração e oferece a saída.

---

## 2. Régua de follow-up com propósito por toque (1 / 3 / 7 / 11 / 15)

**Ideia.** Hoje os follow-ups de 1, 7 e 15 dias são o mesmo convite, com palavras diferentes.
A régua proposta dá uma função diferente para cada toque:

| Dia | Função | Conteúdo |
| --- | --- | --- |
| 1 | Resposta completa | Valor, o que está incluso, duração, se o retorno entra, formas de pagamento — e fecha com **dois horários específicos**, não "temos vaga essa semana" |
| 3 | Lembrete leve | Retoma os dois horários oferecidos |
| 7 | **Não falar de agendamento** | Conteúdo sobre a queixa que a pessoa trouxe (ver item 3). Reabre a conversa sem cobrar resposta |
| 11 | Agenda real | Avisar que as datas próximas estão enchendo — **só quando for verdade** (ver item 4) |
| 15 | Encerramento com porta aberta | "Vou encerrar por aqui, mas é só chamar quando quiser" — boa parte das respostas chega neste toque |

**Onde entra.** `src/config.js` (`followUpOffsets` vira uma lista de objetos `{ dias, tipo }`),
`src/core/reminders.js` (`scheduleFollowUps` e `textoDe` passam a olhar o tipo) e
`src/core/messages.js` (um texto por tipo).

**Esforço.** Médio. O agendador já suporta N lembretes; muda o formato da configuração e os textos.

**Cuidado.** Cinco toques é o limite do razoável. O opt-out (`sair`) precisa continuar valendo em
todos, e quem responder em qualquer ponto sai da régua — isso o código já faz.

---

## 3. Biblioteca de conteúdo por queixa (toque do dia 7)

**Ideia.** Em vez de cobrar agendamento, mandar algo útil sobre o assunto que a pessoa trouxe:
um vídeo, um post, uma orientação curta.

**Onde entra.** Um cadastro novo em `src/clinic.js` (`contents: [{ id, tema, titulo, link }]`),
uma etiqueta de tema no contato (`contact.tema`) preenchida quando o paciente escreve o motivo, e o
lembrete do dia 7 escolhendo o conteúdo pelo tema. Aba nova no painel para cadastrar os conteúdos.

**Esforço.** Médio-alto: é o único item que cria uma entidade nova.

**Cuidado — o mais importante da lista.** O bot não pode virar canal de orientação clínica.
O conteúdo tem que ser material educativo já publicado pelo consultório, nunca resposta a sintoma;
e a etiqueta deve guardar **tema** ("dor lombar"), não relato clínico — quanto menos dado de saúde
no WhatsApp, melhor para a LGPD e para o paciente.

---

## 4. Escassez verdadeira, calculada da agenda (toque do dia 11)

**Ideia.** Avisar que as datas próximas estão enchendo funciona; inventar isso queima a clínica,
porque o paciente percebe quando a vaga "que ia acabar" continua lá na semana seguinte.

**Onde entra.** `src/core/agenda.js` ganha algo como `ocupacao(dias = 7)` → percentual de horários
tomados na janela. O lembrete do dia 11 só sai com a mensagem de agenda cheia **se a ocupação
passar de um limite real** (ex.: 80%); abaixo disso, manda o convite normal.

**Esforço.** Pequeno-médio. Os dados já existem: `slotsFor` e `bookings`.

**Por que vale.** A honestidade aqui é verificável pelo próprio sistema — o bot fica impedido de
mentir sobre a agenda, mesmo que alguém escreva a mensagem com pressa.

---

## 5. Resposta completa de preço com dois horários

**Ideia.** Se a resposta à pergunta de preço é só o número, o paciente compara preço e decide por
preço. Responder o pacote inteiro (valor, o que inclui, duração, retorno, pagamento) e fechar com
**dois horários concretos** muda a conversa.

**Onde entra.** `src/core/messages.js` → `valores(clinic)`, hoje devolve valor + pagamento e um
convite genérico. Passa a montar a resposta completa a partir de `clinic.services` e, no
`src/core/bot.js`, anexa os dois próximos horários livres (`agenda.nextAvailableDays(1)`).

**Esforço.** Pequeno.

---

## 6. Taxa de falta no painel

**Ideia.** A maioria dos consultórios não conhece a própria taxa de falta — e sem o número não dá
para saber se o follow-up está funcionando.

**Onde entra.** Os dados já estão guardados (`booking.attendance` = `compareceu` / `faltou`,
`booking.confirmation`). Falta calcular e mostrar:

- taxa de falta do mês, geral e por profissional;
- comparação **confirmados × não confirmados** (mede o valor do lembrete de véspera);
- quantos agendamentos vieram depois do 1º, 2º, 3º toque de follow-up — exige guardar em
  `booking.origem` qual lembrete precedeu a marcação.

**Esforço.** Pequeno para as duas primeiras (só somar o que já existe); médio para a atribuição
por toque.
