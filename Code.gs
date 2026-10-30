/** Agenda Dev - alertas automáticos por Gmail.
 * Os dados são guardados nas propriedades do projeto Apps Script.
 * Execute configurarServico() uma vez e publique como Aplicativo da Web.
 */
const PREFIXO = 'AGENDA_DEV_CONTA_';

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw) return resposta_({ ok: false, error: 'Payload ausente' });
    const p = JSON.parse(raw);
    if (!p.accountId || !/^[a-zA-Z0-9-]{12,80}$/.test(p.accountId)) {
      return resposta_({ ok: false, error: 'Identificador inválido' });
    }
    if (p.action === 'sync') {
      const recipient = String(p.recipient || '').trim().toLowerCase();
      if (recipient && !/^[^\\s@]+@gmail\\.com$/.test(recipient)) {
        return resposta_({ ok: false, error: 'Destinatário precisa ser Gmail' });
      }
      const tasks = Array.isArray(p.tasks) ? p.tasks.slice(0, 500).map(sanitizarTarefa_) : [];
      const data = {
        accountId: p.accountId,
        username: String(p.username || 'Usuário').slice(0, 80),
        recipient: recipient,
        tasks: tasks,
        updatedAt: Date.now()
      };
      PropertiesService.getScriptProperties().setProperty(PREFIXO + p.accountId, JSON.stringify(data));
      return resposta_({ ok: true, saved: tasks.length });
    }
    return resposta_({ ok: false, error: 'Ação desconhecida' });
  } catch (err) {
    console.error(err);
    return resposta_({ ok: false, error: String(err) });
  }
}

function sanitizarTarefa_(t) {
  return {
    id: String(t.id || '').slice(0, 80),
    title: String(t.title || 'Tarefa').slice(0, 100),
    description: String(t.description || '').slice(0, 300),
    date: /^\\d{4}-\\d{2}-\\d{2}$/.test(t.date) ? t.date : '',
    time: /^\\d{2}:\\d{2}$/.test(t.time) ? t.time : '08:00',
    completed: t.completed === true,
    priority: String(t.priority || '').slice(0, 20),
    category: String(t.category || '').slice(0, 30)
  };
}

function verificarPrazos() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const agora = Date.now();
  Object.keys(all).filter(k => k.indexOf(PREFIXO) === 0).forEach(key => {
    try {
      const conta = JSON.parse(all[key]);
      if (!conta.recipient || !Array.isArray(conta.tasks)) return;
      conta.tasks.forEach(t => {
        if (t.completed || !t.date || !t.time || !t.id) return;
        const prazo = new Date(t.date + 'T' + t.time + ':00').getTime();
        if (!Number.isFinite(prazo)) return;
        const falta = prazo - agora;
        const assinatura = Utilities.base64EncodeWebSafe(
          Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, [t.title, t.date, t.time].join('|'))
        ).slice(0, 18);
        const chaveEstado = 'AVISO_' + conta.accountId + '_' + t.id + '_' + assinatura;
        const estado = props.getProperty(chaveEstado) || '';
        if (falta > 0 && falta <= 24 * 60 * 60 * 1000 && estado.indexOf('24h') === -1) {
          enviarAviso_(conta.recipient, conta.username, t, 'Seu prazo está próximo', 'Falta menos de 24 horas para o prazo desta tarefa.');
          props.setProperty(chaveEstado, estado + '|24h');
        } else if (falta <= 0 && estado.indexOf('vencida') === -1) {
          enviarAviso_(conta.recipient, conta.username, t, 'Prazo vencido', 'O prazo desta tarefa já passou.');
          props.setProperty(chaveEstado, estado + '|vencida');
        }
      });
    } catch (err) { console.error('Erro na conta ' + key, err); }
  });
}

function enviarAviso_(email, usuario, tarefa, assunto, mensagem) {
  const dataHora = tarefa.date + ' às ' + tarefa.time;
  const corpo = [
    'Olá, ' + usuario + '!', '', mensagem, '',
    'Tarefa: ' + tarefa.title,
    'Descrição: ' + (tarefa.description || 'Sem descrição'),
    'Prazo: ' + dataHora,
    'Prioridade: ' + (tarefa.priority || 'Não informada'),
    'Categoria: ' + (tarefa.category || 'Não informada'), '',
    'Mensagem automática da Agenda Dev.'
  ].join('\\n');
  MailApp.sendEmail({ to: email, subject: '[Agenda Dev] ' + assunto + ': ' + tarefa.title, body: corpo, name: 'Agenda Dev' });
}

function configurarServico() {
  // Cria um único gatilho periódico de verificação (a cada 5 minutos).
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'verificarPrazos')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('verificarPrazos').timeBased().everyMinutes(5).create();
  Logger.log('Serviço configurado. Autorize o acesso ao Gmail quando solicitado.');
}

function testarEnvio() {
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('Não foi possível identificar seu Gmail.');
  MailApp.sendEmail(email, '[Agenda Dev] Teste de envio', 'Integração de e-mail configurada com sucesso.');
}

function resposta_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
