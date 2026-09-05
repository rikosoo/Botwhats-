'use strict';

/** Tira acentos, pontuacao e espacos extras para comparar o que o paciente escreveu. */
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Intencoes reconhecidas. A ordem importa: a primeira que casar vence.
 * Sao expressoes do dia a dia, nao comandos — o paciente escreve como fala.
 */
const INTENCOES = [
  ['sair', [/\b(sair|parar|para de mandar|nao quero mais receber|descadastrar|remover meu numero|stop)\b/]],
  ['atendente', [/\b(atendente|secretaria|recepcao|falar com (alguem|uma pessoa|humano)|pessoa de verdade|nao e robo)\b/]],
  ['cancelar', [/\b(cancelar|desmarcar|nao vou poder ir|nao vou conseguir ir|desistir da consulta)\b/]],
  ['remarcar', [/\b(remarcar|reagendar|mudar (o )?(horario|dia|a data)|trocar (o )?horario|adiar|antecipar)\b/]],
  ['confirmar_presenca', [/\b(confirmar|confirmo|confirmado|vou sim|estarei la|pode confirmar|vou comparecer)\b/]],
  ['agendar', [/\b(agendar|marcar|marca|agenda pra mim|quero uma consulta|preciso de (uma )?consulta|nova consulta|primeira consulta|retorno|consultar|horario com (o|a) (dr|dra)|passar em consulta)\b/]],
  ['minhas_consultas', [/\b(minha consulta|minhas consultas|meu horario|meus horarios|meu agendamento|quando (e|eh) minha|ja tenho (consulta|horario))\b/]],
  ['horarios', [/\b(horarios? (livres?|disponiveis?|vagos?)|tem vaga|qual (o )?horario|que horas voces? atende|disponibilidade)\b/]],
  ['endereco', [/\b(endereco|onde (fica|voces? fica|e o consultorio)|localizacao|como chego|estacionamento|referencia)\b/]],
  ['convenios', [/\b(convenio|plano de saude|unimed|bradesco|sulamerica|amil|aceita (meu )?plano|atende (pelo|por) convenio)\b/]],
  ['valores', [/\b(valor|preco|quanto custa|quanto e a consulta|particular|forma de pagamento|aceita (pix|cartao))\b/]],
  ['preparo', [/\b(preparo|jejum|posso comer|antes do exame|como me preparo|precisa de jejum)\b/]],
  ['documentos', [/\b(o que (levar|preciso levar)|documento|carteirinha|pedido medico|exames anteriores)\b/]],
  ['saudacao', [/^(oi+|ola|opa|eai|e ai|bom dia|boa tarde|boa noite|hey|alo)\b/]],
  ['agradecimento', [/\b(obrigad|valeu|agradec|muito obrigado|show|otimo|perfeito|ok obrigado)\b/]],
  ['ajuda', [/\b(menu|opcoes|voltar|inicio|ajuda|o que voce faz|como funciona)\b/]],
  ['sim', [/^(sim|s|isso|claro|pode ser|ok|certo|positivo|aham|uhum|quero|bora|beleza|blz)$/]],
  ['nao', [/^(nao|n|nops|negativo|agora nao|depois)$/]],
];

/** Descobre a intencao do texto. Devolve null quando nao reconhece. */
function detectarIntencao(texto) {
  const t = normalizar(texto);
  if (!t) return null;
  for (const [nome, padroes] of INTENCOES) {
    if (padroes.some((re) => re.test(t))) return nome;
  }
  return null;
}

/** Le uma escolha numerica ("2", "opcao 3", "o terceiro"). */
function lerNumero(texto, maximo) {
  const t = normalizar(texto);
  const ordinais = ['primeir', 'segund', 'terceir', 'quart', 'quint', 'sext', 'setim', 'oitav', 'non', 'decim'];
  const porExtenso = ['um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez'];

  const direto = t.match(/(?:^|\s)(\d{1,2})(?:$|\s|\)|-)/);
  if (direto) {
    const n = Number(direto[1]);
    if (n >= 1 && (!maximo || n <= maximo)) return n;
  }
  for (let i = 0; i < ordinais.length; i += 1) if (t.includes(ordinais[i])) return i + 1;
  for (let i = 0; i < porExtenso.length; i += 1) {
    if (new RegExp(`\\b${porExtenso[i]}\\b`).test(t)) return i + 1;
  }
  return null;
}

/**
 * Horarios que combinam com o que foi escrito: "14:00", "14h", "as 9", "9h30".
 * Devolve lista porque "9h" pode casar com 09:00, 09:20 e 09:40 — nesse caso
 * quem chama pergunta qual em vez de adivinhar.
 */
function lerHorarioCandidatos(texto, opcoes) {
  const t = normalizar(texto);
  const m = t.match(/(\d{1,2})\s*(?::|h|hs)\s*(\d{2})?/);
  if (!m) return [];
  const hora = String(Number(m[1])).padStart(2, '0');
  const minuto = m[2] ? m[2] : null;
  return opcoes.filter((o) => (minuto ? o === `${hora}:${minuto}` : o.startsWith(`${hora}:`)));
}

/** Horario unico, ou null quando nao da para ter certeza. */
function lerHorario(texto, opcoes) {
  const candidatos = lerHorarioCandidatos(texto, opcoes);
  return candidatos.length === 1 ? candidatos[0] : null;
}

/** Reconhece o convenio citado entre os aceitos pelo consultorio. */
function lerConvenio(texto, aceitos) {
  const t = normalizar(texto);
  return aceitos.find((c) => t.includes(normalizar(c))) || null;
}

/** Aceita datas escritas como 12/05/1980 ou 12-05-1980. */
function lerDataNascimento(texto) {
  const m = normalizar(texto).match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (!m) return null;
  const [, d, mes, a] = m;
  const ano = a.length === 2 ? Number(a) + (Number(a) > 30 ? 1900 : 2000) : Number(a);
  if (Number(mes) < 1 || Number(mes) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  if (ano < 1900 || ano > new Date().getFullYear()) return null;
  return `${String(d).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`;
}

/** Nome plausivel: duas palavras, sem numeros. */
function pareceNome(texto) {
  const t = String(texto || '').trim();
  return /^[A-Za-zÀ-ÿ'´`^~\s.]{4,60}$/.test(t) && t.split(/\s+/).length >= 2;
}

module.exports = {
  normalizar,
  detectarIntencao,
  lerNumero,
  lerHorario,
  lerHorarioCandidatos,
  lerConvenio,
  lerDataNascimento,
  pareceNome,
  INTENCOES,
};
