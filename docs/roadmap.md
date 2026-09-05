# Backlog — ideias para as próximas versões

Anotações vindas de conteúdo sobre captação e follow-up em consultório, traduzidas para onde
cada uma encaixa neste código. Nada aqui está implementado ainda.

**Feito:** 1, 5, 6, 7 e 8 — e a cadência do item 2 (7/3 dias, sem contagem regressiva). **Na fila:** 4 → 2 (conteúdo por toque) → 3.

---

## 1. Confirmação que mostra o que foi reservado, em vez de "confirma?"

> ✅ **Implementado.**

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

> ✅ **Implementado.**

**Ideia.** Se a resposta à pergunta de preço é só o número, o paciente compara preço e decide por
preço. Responder o pacote inteiro (valor, o que inclui, duração, retorno, pagamento) e fechar com
**dois horários concretos** muda a conversa.

**Onde entra.** `src/core/messages.js` → `valores(clinic)`, hoje devolve valor + pagamento e um
convite genérico. Passa a montar a resposta completa a partir de `clinic.services` e, no
`src/core/bot.js`, anexa os dois próximos horários livres (`agenda.nextAvailableDays(1)`).

**Esforço.** Pequeno.

---

## 6. Taxa de falta no painel

> ✅ **Implementado.**

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

---

## 7. Check-in no dia seguinte à consulta

> ✅ **Implementado.**

**Ideia.** Um dia depois do atendimento, uma mensagem curta:

> "Oi, [nome]! Passando para saber como você está depois da consulta de ontem. Ficou alguma dúvida
> sobre as orientações, ou tem algo em que possamos ajudar?"

É simples, mas comunica três coisas: *lembro de você*, *estou acompanhando*, *você não virou
apenas mais um atendimento*. Também é onde aparecem cedo os problemas de adesão — quem não
entendeu a orientação costuma dizer isso aqui, não no retorno de 30 dias.

**Onde entra.** `src/core/reminders.js` ganha `kind: 'pos_consulta'`, agendado quando a recepção
marca **compareceu** no painel (`POST /api/bookings/:id/status`), com vencimento em D+1 — no mesmo
lugar onde hoje nasce o lembrete de retorno. Texto novo em `src/core/messages.js`. No painel, entra
na fila de lembretes como os outros.

**Esforço.** Pequeno: o gancho do `compareceu` já existe e já dispara um lembrete.

**Cuidado.** Esta mensagem **convida a dúvida clínica** — é o objetivo dela. O bot não pode
responder nenhuma: a resposta do paciente tem que cair na fila da recepção (o
`semConselhoMedico` + handoff já fazem isso, mas vale um teste específico para esse caminho).
E a pergunta deve ser sobre *dúvidas nas orientações*, nunca "como estão seus sintomas?" — evita
transformar o WhatsApp em prontuário.

---

## 8. Toque no meio da espera, com utilidade no lugar de cobrança

> ✅ **Implementado.**

**Ideia.** O paciente marca na terça uma consulta da semana seguinte, e nesse intervalo ninguém
fala com ele. Ele esfria — aparece uma reunião, um imprevisto, e a consulta é a primeira coisa que
sai da agenda dele. O que segura é uma mensagem no meio da espera **com utilidade**:

> "[Nome], conferimos que você tem um agendamento no dia [X]. Se tiver algum exame recente, pode
> levar no dia — a Dra. já avalia e adianta o plano de tratamento."

Quem recebe informação útil antes chega sentindo que a consulta já começou.

**Onde entra.** Duas partes:

1. **O texto.** `src/core/messages.js` → `lembreteConsulta(...)`, ramo dos 15/7 dias. Hoje ele diz
   *"Faltam N dias para a sua consulta. Está tudo certo para você?"* — que é exatamente a cobrança
   que o story descreve. Trocar pela versão útil (levar exames recentes, o preparo do tipo de
   atendimento, o que adianta a consulta).
2. **O momento.** Em vez de só 15/7 dias fixos, calcular o **meio da espera**
   (`created + (startsAt - created) / 2`) em `scheduleBookingReminders`, disparando esse toque
   quando o intervalo entre a marcação e a consulta passar de ~4 dias. Assim quem marca com 9 dias
   de antecedência também recebe um toque no meio, não só a véspera.

**Esforço.** Pequeno para o texto (item 1 da lista acima), médio para o cálculo do meio da espera.

**Por que vale.** É o buraco mais comum da agenda: a consulta marcada com folga é justamente a que
some. O código já guarda `createdAt` e `startsAt` — falta usar os dois juntos.

---

# O que ainda falta para uso real

Levantamento do que um consultório sentiria falta hoje, em ordem de urgência.
Os três primeiros são o que eu resolveria antes de ligar isso num número de verdade.
**B e C já estão feitos** — falta o A, que é o bloqueador.

## A. Login no painel  ⚠️ bloqueador

Hoje qualquer pessoa que alcance a porta do servidor abre o painel e vê nome, telefone, data de
nascimento, convênio e conversa de todos os pacientes. Sem autenticação, isso não pode ficar
exposto na internet. Mínimo: login com senha, sessão, HTTPS e o `data/db.json` fora do alcance
público. Depois: um usuário por pessoa da equipe, para saber quem respondeu o quê.

## B. Áudio e imagem  ⚠️ buraco silencioso

> ✅ **Implementado.**

`src/channels/whatsappWeb.js` ignora tudo que não é texto (`msg.type !== 'chat'`). Na prática, o
paciente manda um áudio — que é o jeito mais comum de responder no WhatsApp — e **não recebe
resposta nenhuma**. O mínimo é responder ("não consigo ouvir áudio por aqui, pode escrever? já
avisei a recepção") e jogar a conversa para a fila humana. Foto de carteirinha e de pedido médico
seguem o mesmo caminho, com o cuidado de não guardar imagem clínica.

## C. Lista de espera e encaixe

> ✅ **Implementado.**

Fecha o ciclo que o "não vem" e o cancelamento abriram: quando um horário volta para a agenda,
oferecer automaticamente para quem está esperando — em ordem, com prazo para responder antes de
passar para o próximo. É o recurso que transforma falta em consulta, e todo o dado necessário já
existe.

## D. Integração com a agenda que o consultório já usa

Google Calendar ou o sistema de prontuário (iClinic, Feegow, Doctoralia e afins). Sem isso a
secretária digita tudo duas vezes e as duas agendas divergem — que é o jeito mais rápido de o
consultório abandonar a ferramenta.

## E. Sinal ou pagamento antecipado

Link de Pix na confirmação da primeira consulta. É a medida com efeito mais direto sobre falta em
consultório particular. Exige tratar reembolso e cancelamento com regra clara.

## F. LGPD na prática

Apagar os dados de um paciente a pedido dele, política de retenção (o histórico não precisa ficar
para sempre), registro de consentimento e backup do banco. Hoje o `db.json` não tem nada disso.

## G. Recall por procedimento

Retorno anual, revisão de exame, acompanhamento periódico — um recall com prazo próprio por tipo
de atendimento, além do retorno de 30 dias que já existe.

## H. Mais de uma unidade

Endereços diferentes, com o profissional atendendo em cada um em dias distintos.
