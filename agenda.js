/* =====================================================
   AGENDA DEV
   - Contas e tarefas ficam no localStorage deste navegador
   - Senhas são guardadas com hash PBKDF2 (nunca em texto puro)
===================================================== */

const USERS_STORAGE_KEY = "agendaDevUsers";
const CURRENT_USER_KEY = "agendaDevCurrentUser";
const THEME_KEY = "agendaDevTheme";

const $ = (id) => document.getElementById(id);

const loginScreen = $("loginScreen");
const app = $("app");
const loginError = $("loginError");
const loginForm = $("loginForm");
const loginUsername = $("loginUsername");
const loginPassword = $("loginPassword");
const confirmPassword = $("confirmPassword");
const confirmPasswordField = $("confirmPasswordField");
const submitLogin = $("submitLogin");
const toggleLoginMode = $("toggleLoginMode");
const togglePassword = $("togglePassword");
const loginSubtitle = $("loginSubtitle");

const taskForm = $("taskForm");
const taskTitle = $("taskTitle");
const taskDescription = $("taskDescription");
const taskDate = $("taskDate");
const taskTime = $("taskTime");
const taskPriority = $("taskPriority");
const taskCategory = $("taskCategory");
const taskList = $("taskList");
const searchInput = $("searchInput");
const sortSelect = $("sortSelect");

let modoCadastro = false;
let editingId = null;
let currentFilter = "all";
let categoryFilter = "";
let currentUser = null;
let tasks = [];

/* =====================================================
   SINCRONIZAÇÃO E ALERTAS POR E-MAIL (GOOGLE APPS SCRIPT)
===================================================== */
const EMAIL_DESTINO_KEY = "agendaDevEmailDestino";
const CLOUD_ID_KEY = "agendaDevCloudId";
let syncTimer = null;

function idNuvem() {
    let id = localStorage.getItem(CLOUD_ID_KEY);
    if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        localStorage.setItem(CLOUD_ID_KEY, id);
    }
    return id;
}

function carregarConfigEmail() {
    const campo = $("emailDestino");
    if (campo) campo.value = localStorage.getItem(EMAIL_DESTINO_KEY) || "";
}

async function enviarParaAppsScript(acao = "sync") {
    const endpoint = window.AGENDA_EMAIL_CONFIG?.WEB_APP_URL;
    if (!endpoint || endpoint.includes("COLE_A_URL")) {
        const status = $("emailStatus");
        if (status) status.textContent = "Falta configurar a URL do Google Apps Script no arquivo config.js.";
        return;
    }
    if (!currentUser) return;
    const payload = {
        action: acao,
        accountId: idNuvem(),
        username: currentUser.username,
        recipient: localStorage.getItem(EMAIL_DESTINO_KEY) || "",
        tasks: tasks
    };
    try {
        // POST simples (text/plain) evita limite de tamanho de URL para listas grandes.
        // O Apps Script recebe o corpo mesmo sem liberar leitura CORS.
        await fetch(endpoint, {
            method: "POST",
            mode: "no-cors",
            cache: "no-store",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload)
        });
        const status = $("emailStatus");
        if (status) status.textContent = "Solicitação enviada. O serviço verificará os prazos automaticamente.";
    } catch (erro) {
        console.error("Falha ao sincronizar com o serviço de e-mail:", erro);
        const status = $("emailStatus");
        if (status) status.textContent = "Não foi possível enviar a sincronização. Verifique a conexão e a URL do Apps Script.";
    }
}

function sincronizarComNuvem() {
    if (!currentUser) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => enviarParaAppsScript("sync"), 500);
}

$("salvarEmail")?.addEventListener("click", () => {
    const campo = $("emailDestino");
    const email = (campo?.value || "").trim().toLowerCase();
    if (!/^[^\s@]+@gmail\.com$/i.test(email)) {
        $("emailStatus").textContent = "Digite um endereço válido terminado em @gmail.com.";
        campo?.focus();
        return;
    }
    localStorage.setItem(EMAIL_DESTINO_KEY, email);
    $("emailStatus").textContent = "Endereço salvo. Sincronizando tarefas...";
    enviarParaAppsScript("sync");
});

/* =====================================================
   UTILITÁRIOS
===================================================== */

function dataLocal(data = new Date()) {
    const ano = data.getFullYear();
    const mes = String(data.getMonth() + 1).padStart(2, "0");
    const dia = String(data.getDate()).padStart(2, "0");
    return `${ano}-${mes}-${dia}`;
}

function normalizarUsuario(nome) {
    return String(nome || "").trim().toLowerCase();
}

function prazoDe(task) {
    return new Date(`${task.date}T${task.time}:00`).getTime();
}

function formatarData(data) {
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return "Sem data";

    const d = new Date(`${data}T00:00:00`);
    if (Number.isNaN(d.getTime()) || dataLocal(d) !== data) return "Sem data";

    return new Intl.DateTimeFormat("pt-BR").format(d);
}

function plural(n, singular, pluralTxt) {
    return `${n} ${n === 1 ? singular : pluralTxt}`;
}

/* =====================================================
   TEMA CLARO / ESCURO
===================================================== */

function aplicarTema(tema) {
    document.documentElement.setAttribute("data-theme", tema);
}

(function iniciarTema() {
    let tema = "dark";
    try {
        tema = localStorage.getItem(THEME_KEY) || tema;
    } catch (e) { /* ignora */ }
    aplicarTema(tema === "light" ? "light" : "dark");
})();

$("themeToggle").addEventListener("click", () => {
    const novo =
        document.documentElement.getAttribute("data-theme") === "light"
            ? "dark"
            : "light";
    aplicarTema(novo);
    try {
        localStorage.setItem(THEME_KEY, novo);
    } catch (e) { /* ignora */ }
});

/* =====================================================
   CONTAS (hash de senha)
===================================================== */

function bytesParaHex(buffer) {
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function hexParaBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}

async function gerarHash(senha, saltHex) {
    if (!window.crypto || !window.crypto.subtle) {
        throw new Error(
            "Este navegador não oferece criptografia segura. Abra a agenda em um navegador atualizado."
        );
    }

    const chave = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(senha),
        "PBKDF2",
        false,
        ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: hexParaBytes(saltHex),
            iterations: 150000,
            hash: "SHA-256"
        },
        chave,
        256
    );

    return bytesParaHex(bits);
}

function novoSalt() {
    return bytesParaHex(crypto.getRandomValues(new Uint8Array(16)));
}

function carregarUsuarios() {
    try {
        const dados = JSON.parse(localStorage.getItem(USERS_STORAGE_KEY) || "{}");
        return dados && typeof dados === "object" && !Array.isArray(dados)
            ? dados
            : {};
    } catch (erro) {
        console.warn("Não foi possível ler as contas:", erro);
        return {};
    }
}

function salvarUsuarios(usuarios) {
    try {
        localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(usuarios));
        return true;
    } catch (erro) {
        console.error("Não foi possível salvar as contas:", erro);
        return false;
    }
}

/* =====================================================
   TAREFAS (armazenamento por usuário)
===================================================== */

function chaveTarefasUsuario(usuario = currentUser) {
    const nome = typeof usuario === "string" ? usuario : usuario?.username;
    return `agendaDevTasks_${encodeURIComponent(normalizarUsuario(nome || "convidado"))}`;
}

function carregarTarefas() {
    if (!currentUser) return [];

    let dados;

    try {
        dados = JSON.parse(localStorage.getItem(chaveTarefasUsuario()) || "[]");
    } catch (erro) {
        console.warn("Não foi possível ler as tarefas salvas:", erro);
        return [];
    }

    if (!Array.isArray(dados)) return [];

    const prioridades = ["Alta", "Média", "Baixa"];
    const categorias = ["Estudos", "Trabalho", "Pessoal", "Urgente"];

    return dados
        .filter(
            (t) =>
                t &&
                typeof t === "object" &&
                t.id !== undefined &&
                t.id !== null &&
                typeof t.title === "string"
        )
        .map((t) => ({
            id: t.id,
            title: t.title.trim(),
            description: String(t.description || ""),
            date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : dataLocal(),
            time: /^\d{2}:\d{2}$/.test(t.time) ? t.time : "08:00",
            priority: prioridades.includes(t.priority) ? t.priority : "Baixa",
            category: categorias.includes(t.category) ? t.category : "Estudos",
            completed: t.completed === true,
            createdAt: Number(t.createdAt) || Number(t.id) || Date.now()
        }));
}

function salvarTarefas() {
    if (!currentUser) return false;

    try {
        localStorage.setItem(chaveTarefasUsuario(), JSON.stringify(tasks));
        sincronizarComNuvem();
        return true;
    } catch (erro) {
        console.error("Não foi possível salvar as tarefas:", erro);
        alert("Não foi possível salvar suas tarefas. O armazenamento do navegador pode estar cheio ou bloqueado.");
        return false;
    }
}

function estaAtrasada(task) {
    if (task.completed) return false;
    return prazoDe(task) < Date.now();
}

/* =====================================================
   RELÓGIO
===================================================== */

function atualizarRelogio() {
    const agora = new Date();

    $("currentDate").textContent = new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        month: "long",
        year: "numeric"
    }).format(agora);

    $("currentDay").textContent = new Intl.DateTimeFormat("pt-BR", {
        weekday: "long"
    }).format(agora);

    $("clock").textContent = new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).format(agora);
}

/* =====================================================
   SESSÃO / LOGIN
===================================================== */

function mostrarLogin() {
    loginScreen.style.display = "grid";
    app.style.display = "none";
    esconderNotificacaoTempo();
}

function abrirAgenda(usuario) {
    currentUser = usuario;
    tasks = carregarTarefas();

    loginScreen.style.display = "none";
    app.style.display = "block";

    $("userGreeting").textContent = `Olá, ${usuario.username}!`;
    $("userGreeting").title = usuario.username;
    $("userAvatar").textContent = usuario.username.charAt(0) || "D";

    resetarFormulario();
    renderizarTarefas();
    verificarTempoDasTarefas();
    carregarConfigEmail();
    sincronizarComNuvem();
}

function iniciarSessao(usuario) {
    try {
        sessionStorage.setItem(CURRENT_USER_KEY, JSON.stringify(usuario));
    } catch (erro) {
        console.warn("Não foi possível salvar a sessão:", erro);
    }

    abrirAgenda(usuario);
}

function recuperarSessao() {
    try {
        const usuario = JSON.parse(sessionStorage.getItem(CURRENT_USER_KEY) || "null");

        if (usuario && typeof usuario === "object" && typeof usuario.username === "string") {
            // só aceita a sessão se a conta ainda existir
            if (carregarUsuarios()[normalizarUsuario(usuario.username)]) {
                return { username: usuario.username };
            }
        }
    } catch (erro) {
        console.warn("Sessão inválida:", erro);
    }

    return null;
}

function definirModoCadastro(ativar) {
    modoCadastro = Boolean(ativar);
    loginError.textContent = "";
    confirmPasswordField.hidden = !modoCadastro;
    confirmPassword.required = modoCadastro;

    loginPassword.autocomplete = modoCadastro ? "new-password" : "current-password";

    submitLogin.textContent = modoCadastro ? "Criar conta" : "Entrar na agenda";
    toggleLoginMode.textContent = modoCadastro ? "Já tenho conta — entrar" : "Criar conta";
    loginSubtitle.textContent = modoCadastro
        ? "Crie um login e uma senha para começar."
        : "Entre com seu login e sua senha para acessar a agenda.";
}

toggleLoginMode.addEventListener("click", () => {
    definirModoCadastro(!modoCadastro);
    loginPassword.focus();
});

loginForm.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    loginError.textContent = "";

    const username = loginUsername.value.trim();
    const password = loginPassword.value;

    if (username.length < 3) {
        loginError.textContent = "O login precisa ter pelo menos 3 caracteres.";
        loginUsername.focus();
        return;
    }

    if (password.length < 4) {
        loginError.textContent = "A senha precisa ter pelo menos 4 caracteres.";
        loginPassword.focus();
        return;
    }

    if (modoCadastro && password.length < 8) {
        loginError.textContent = "Para criar uma conta, use uma senha com pelo menos 8 caracteres.";
        loginPassword.focus();
        return;
    }

    if (modoCadastro && password !== confirmPassword.value) {
        loginError.textContent = "As senhas não conferem.";
        confirmPassword.focus();
        return;
    }

    submitLogin.disabled = true;
    submitLogin.textContent = modoCadastro ? "Criando conta..." : "Entrando...";

    try {
        const usuarios = carregarUsuarios();
        const chave = normalizarUsuario(username);

        if (modoCadastro) {
            if (usuarios[chave]) {
                throw new Error("Esse login já está cadastrado.");
            }

            const salt = novoSalt();
            const hash = await gerarHash(password, salt);

            usuarios[chave] = { username, salt, hash, createdAt: Date.now() };

            if (!salvarUsuarios(usuarios)) {
                throw new Error("Não foi possível criar a conta.");
            }

            loginForm.reset();
            definirModoCadastro(false);
            iniciarSessao({ username });
        } else {
            const usuario = usuarios[chave];
            let confere = false;

            if (usuario && usuario.hash && usuario.salt) {
                confere = (await gerarHash(password, usuario.salt)) === usuario.hash;
            } else if (usuario && typeof usuario.password === "string") {
                // conta antiga (senha em texto puro): confere e migra para hash
                confere = usuario.password === password;

                if (confere) {
                    const salt = novoSalt();
                    usuarios[chave] = {
                        username: usuario.username,
                        salt,
                        hash: await gerarHash(password, salt),
                        createdAt: usuario.createdAt || Date.now()
                    };
                    salvarUsuarios(usuarios);
                }
            }

            if (!confere) {
                throw new Error("Login ou senha incorretos.");
            }

            loginForm.reset();
            definirModoCadastro(false);
            iniciarSessao({ username: usuario.username });
        }
    } catch (erro) {
        loginError.textContent =
            erro instanceof Error ? erro.message : "Não foi possível concluir o acesso.";
        submitLogin.textContent = modoCadastro ? "Criar conta" : "Entrar na agenda";
    } finally {
        submitLogin.disabled = false;
    }
});

togglePassword.addEventListener("click", (evento) => {
    const mostrar = loginPassword.type === "password";
    const tipo = mostrar ? "text" : "password";

    loginPassword.type = tipo;
    confirmPassword.type = tipo;

    const rotulo = mostrar ? "Ocultar senha" : "Mostrar senha";
    evento.currentTarget.setAttribute("aria-label", rotulo);
    evento.currentTarget.title = rotulo;
});

function logout() {
    try {
        sessionStorage.removeItem(CURRENT_USER_KEY);
    } catch (erro) {
        console.warn("Não foi possível encerrar a sessão:", erro);
    }

    currentUser = null;
    tasks = [];
    editingId = null;

    loginForm.reset();
    definirModoCadastro(false);
    mostrarLogin();
}

$("logoutButton").addEventListener("click", logout);

/* =====================================================
   FORMULÁRIO (ADICIONAR / EDITAR)
===================================================== */

function resetarFormulario() {
    editingId = null;
    taskForm.reset();

    taskDate.value = dataLocal();
    taskTime.value = "08:00";
    taskPriority.value = "Alta";
    taskCategory.value = "Estudos";

    $("formTitle").textContent = "Adicionar nova tarefa";
    $("submitButton").textContent = "Adicionar tarefa";
    $("cancelEdit").style.display = "none";
}

taskForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const title = taskTitle.value.trim();

    if (!title) {
        alert("Digite o título da tarefa!");
        taskTitle.focus();
        return;
    }

    const dados = {
        title,
        description: taskDescription.value.trim(),
        date: taskDate.value,
        time: taskTime.value,
        priority: taskPriority.value,
        category: taskCategory.value
    };

    if (editingId !== null) {
        tasks = tasks.map((t) => (t.id === editingId ? { ...t, ...dados } : t));
    } else {
        tasks.push({
            id: Date.now(),
            ...dados,
            completed: false,
            createdAt: Date.now()
        });
    }

    salvarTarefas();
    resetarFormulario();
    renderizarTarefas();
    verificarTempoDasTarefas();
    taskTitle.focus();
});

function editarTarefa(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;

    editingId = id;

    taskTitle.value = task.title;
    taskDescription.value = task.description;
    taskDate.value = task.date;
    taskTime.value = task.time;
    taskPriority.value = task.priority;
    taskCategory.value = task.category;

    $("formTitle").textContent = "Editar tarefa";
    $("submitButton").textContent = "Salvar alterações";
    $("cancelEdit").style.display = "inline-flex";

    focarFormulario();
}

$("cancelEdit").addEventListener("click", resetarFormulario);

function alternarConclusao(id) {
    tasks = tasks.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t));
    salvarTarefas();
    renderizarTarefas();
    verificarTempoDasTarefas();
}

function excluirTarefa(id) {
    if (!confirm("Tem certeza que deseja excluir esta tarefa?")) return;

    tasks = tasks.filter((t) => t.id !== id);

    if (editingId === id) resetarFormulario();

    salvarTarefas();
    renderizarTarefas();
    verificarTempoDasTarefas();
}

/* =====================================================
   FILTROS, BUSCA E ORDENAÇÃO
===================================================== */

function marcarFiltro(filtro) {
    document.querySelectorAll(".filter-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.filter === filtro);
    });
}

function marcarCategoria() {
    document.querySelectorAll(".category").forEach((el) => {
        el.classList.toggle("active", el.dataset.category === categoryFilter);
    });

    $("activeCategory").hidden = !categoryFilter;
    $("activeCategoryName").textContent = categoryFilter;
}

document.querySelectorAll(".filter-btn").forEach((button) => {
    button.addEventListener("click", () => {
        currentFilter = button.dataset.filter;
        marcarFiltro(currentFilter);
        renderizarTarefas();
    });
});

document.querySelectorAll(".category").forEach((el) => {
    el.addEventListener("click", () => {
        categoryFilter = categoryFilter === el.dataset.category ? "" : el.dataset.category;
        renderizarTarefas();
        focarTarefas();
    });
});

$("clearCategory").addEventListener("click", () => {
    categoryFilter = "";
    renderizarTarefas();
});

searchInput.addEventListener("input", renderizarTarefas);
sortSelect.addEventListener("change", renderizarTarefas);

function mostrarTodas() {
    categoryFilter = "";
    currentFilter = "all";
    searchInput.value = "";
    marcarFiltro("all");
    renderizarTarefas();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

/* =====================================================
   RENDERIZAÇÃO
===================================================== */

const ICONES = {
    editar:
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"></path></svg>',
    excluir:
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a1 1 0 01-1 1H7a1 1 0 01-1-1L5 6M10 11v6M14 11v6"></path></svg>',
    vazio:
        '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="3"></rect><path d="M8 2.5v4M16 2.5v4M3 10h18"></path></svg>'
};

function criarElemento(tag, classe, texto) {
    const el = document.createElement(tag);
    if (classe) el.className = classe;
    if (texto !== undefined) el.textContent = texto;
    return el;
}

function criarTarefa(task) {
    const prioridadeClass = { Alta: "alta", Média: "media", Baixa: "baixa" }[task.priority] || "baixa";
    const categoriaClass =
        { Estudos: "estudos", Trabalho: "trabalho", Pessoal: "pessoal", Urgente: "urgente" }[task.category] ||
        "estudos";

    const article = criarElemento(
        "article",
        `task priority-${prioridadeClass}${task.completed ? " completed" : ""}`
    );

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "task-check";
    check.checked = task.completed;
    check.setAttribute("aria-label", "Concluir tarefa");
    check.addEventListener("change", () => alternarConclusao(task.id));

    const info = criarElemento("div", "task-info");
    info.append(
        criarElemento("div", "task-name", task.title),
        criarElemento("div", "task-description", task.description || "Sem descrição")
    );

    const meta = criarElemento("div", "task-meta");
    meta.append(
        criarElemento("span", "task-when", `${formatarData(task.date)} · ${task.time}`),
        criarElemento("span", `tag category-${categoriaClass}`, task.category),
        criarElemento("span", `tag priority-${prioridadeClass}`, task.priority)
    );

    if (estaAtrasada(task)) {
        meta.appendChild(criarElemento("span", "tag late", "Atrasada"));
    }

    const actions = criarElemento("div", "task-actions");

    const edit = criarElemento("button", "icon-btn");
    edit.type = "button";
    edit.innerHTML = ICONES.editar;
    edit.title = "Editar tarefa";
    edit.setAttribute("aria-label", "Editar tarefa");
    edit.addEventListener("click", () => editarTarefa(task.id));

    const remove = criarElemento("button", "icon-btn delete");
    remove.type = "button";
    remove.innerHTML = ICONES.excluir;
    remove.title = "Excluir tarefa";
    remove.setAttribute("aria-label", "Excluir tarefa");
    remove.addEventListener("click", () => excluirTarefa(task.id));

    actions.append(edit, remove);
    article.append(check, info, meta, actions);

    return article;
}

function renderizarTarefas() {
    taskList.innerHTML = "";
    marcarCategoria();

    const pesquisa = searchInput.value.trim().toLowerCase();

    const filtradas = tasks.filter((task) => {
        const texto = `${task.title} ${task.description}`.toLowerCase();

        if (pesquisa && !texto.includes(pesquisa)) return false;
        if (categoryFilter && task.category !== categoryFilter) return false;

        if (currentFilter === "pending") return !task.completed && !estaAtrasada(task);
        if (currentFilter === "completed") return task.completed;
        if (currentFilter === "late") return estaAtrasada(task);

        return true;
    });

    const ordenacao = sortSelect.value;

    if (ordenacao === "date") {
        filtradas.sort((a, b) => prazoDe(a) - prazoDe(b));
    } else if (ordenacao === "newest") {
        filtradas.sort((a, b) => b.createdAt - a.createdAt);
    } else if (ordenacao === "priority") {
        const peso = { Alta: 1, Média: 2, Baixa: 3 };
        filtradas.sort((a, b) => peso[a.priority] - peso[b.priority] || prazoDe(a) - prazoDe(b));
    }

    if (filtradas.length === 0) {
        const empty = criarElemento("div", "empty");
        empty.innerHTML = ICONES.vazio;
        empty.appendChild(criarElemento("p", "", "Nenhuma tarefa encontrada."));
        taskList.appendChild(empty);
    } else {
        filtradas.forEach((task) => taskList.appendChild(criarTarefa(task)));
    }

    atualizarResumo();
    renderizarProximos();
}

function atualizarResumo() {
    const total = tasks.length;
    const concluidas = tasks.filter((t) => t.completed).length;
    const atrasadas = tasks.filter(estaAtrasada).length;

    $("totalTasks").textContent = total;
    $("pendingTasks").textContent = total - concluidas;
    $("completedTasks").textContent = concluidas;
    $("lateTasks").textContent = atrasadas;

    ["Estudos", "Trabalho", "Pessoal", "Urgente"].forEach((cat) => {
        $(`count${cat}`).textContent = tasks.filter((t) => t.category === cat).length;
    });
}

function renderizarProximos() {
    const lista = $("upcomingList");
    lista.innerHTML = "";

    const ativas = tasks
        .filter((t) => !t.completed)
        .sort((a, b) => prazoDe(a) - prazoDe(b))
        .slice(0, 4);

    if (ativas.length === 0) {
        lista.appendChild(criarElemento("li", "up-empty", "Nenhum prazo pendente."));
        return;
    }

    ativas.forEach((t) => {
        const li = criarElemento("li", estaAtrasada(t) ? "is-late" : "");
        li.append(
            criarElemento("div", "up-title", t.title),
            criarElemento("div", "up-when", `${formatarData(t.date)} às ${t.time}`)
        );
        lista.appendChild(li);
    });
}

/* =====================================================
   NAVEGAÇÃO
===================================================== */

function focarFormulario() {
    $("formPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    taskTitle.focus({ preventScroll: true });
}

function focarTarefas() {
    $("tasksPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function mostrarAjuda() {
    alert(
        "AGENDA DEV\n\n" +
        "• Adicione tarefas com data, hora, prioridade e categoria.\n" +
        "• Marque as concluídas e acompanhe o resumo.\n" +
        "• Pesquise, filtre e ordene a lista.\n" +
        "• Edite ou exclua quando precisar.\n" +
        "• O botão de lua/sol no topo troca entre tema escuro e claro.\n\n" +
        "Suas tarefas ficam salvas somente neste navegador."
    );
}

document.querySelectorAll("#mainMenu button").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll("#mainMenu button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");

        const acao = btn.dataset.action;
        if (acao === "inicio") mostrarTodas();
        if (acao === "tarefas") focarTarefas();
        if (acao === "nova") focarFormulario();
        if (acao === "ajuda") mostrarAjuda();
    });
});

/* =====================================================
   AVISO DE PRAZO
===================================================== */

let avisoDispensado = ""; // "id|nivel" já fechado pelo usuário
let avisoAtual = "";

function formatarTempoRestante(tempo) {
    const abs = Math.abs(tempo);
    const dias = Math.floor(abs / 86400000);
    const horas = Math.floor((abs % 86400000) / 3600000);
    const minutos = Math.floor((abs % 3600000) / 60000);
    const segundos = Math.floor((abs % 60000) / 1000);

    if (tempo <= 0) {
        if (dias > 0) return `Prazo vencido há ${plural(dias, "dia", "dias")}`;
        if (horas > 0) return `Prazo vencido há ${plural(horas, "hora", "horas")}`;
        return `Prazo vencido há ${plural(Math.max(1, minutos), "minuto", "minutos")}`;
    }

    if (dias > 0) return `Faltam ${plural(dias, "dia", "dias")}, ${horas}h e ${minutos}min`;
    if (horas > 0) return `Faltam ${horas}h, ${minutos}min e ${segundos}s`;
    if (minutos > 0) return `Faltam ${minutos}min e ${segundos}s`;
    return `Faltam ${segundos}s`;
}

function nivelAviso(tempo) {
    if (tempo <= 0) return "vencido";
    if (tempo <= 3600000) return "urgente";
    return "proximo";
}

function mostrarNotificacaoTempo(tarefa, tempo) {
    const notificacao = $("notificacaoTempo");
    const nivel = nivelAviso(tempo);
    const chave = `${tarefa.id}|${nivel}`;

    avisoAtual = chave;

    if (avisoDispensado === chave) {
        notificacao.classList.remove("mostrar");
        return;
    }

    notificacao.classList.remove("alerta", "perigo");

    if (nivel === "vencido") {
        $("notificacaoTitulo").textContent = "Prazo vencido";
        notificacao.classList.add("perigo");
    } else if (nivel === "urgente") {
        $("notificacaoTitulo").textContent = "Prazo muito próximo";
        notificacao.classList.add("perigo");
    } else {
        $("notificacaoTitulo").textContent = "Aviso de prazo";
        notificacao.classList.add("alerta");
    }

    $("notificacaoTarefa").textContent = tarefa.title || "Tarefa sem título";
    $("notificacaoTexto").textContent = formatarTempoRestante(tempo);
    notificacao.classList.add("mostrar");
}

function esconderNotificacaoTempo() {
    $("notificacaoTempo").classList.remove("mostrar");
}

$("notificacaoFechar").addEventListener("click", () => {
    avisoDispensado = avisoAtual;
    esconderNotificacaoTempo();
});

function verificarTempoDasTarefas() {
    if (!currentUser) return;

    const ativas = tasks.filter((t) => !t.completed && t.date && t.time);

    if (ativas.length === 0) {
        esconderNotificacaoTempo();
        return;
    }

    let maisProxima = null;
    let menor = Infinity;

    ativas.forEach((t) => {
        const tempo = prazoDe(t) - Date.now();
        if (tempo < menor) {
            menor = tempo;
            maisProxima = t;
        }
    });

    // só avisa quando falta menos de 24h (ou já venceu)
    if (!maisProxima || menor > 86400000) {
        esconderNotificacaoTempo();
        return;
    }

    mostrarNotificacaoTempo(maisProxima, menor);
}

/* =====================================================
   INICIALIZAÇÃO
===================================================== */

resetarFormulario();
definirModoCadastro(false);

const sessao = recuperarSessao();

if (sessao) {
    abrirAgenda(sessao);
} else {
    mostrarLogin();
}

atualizarRelogio();

window.setInterval(() => {
    atualizarRelogio();
    verificarTempoDasTarefas();
}, 1000);

// re-renderiza a cada minuto para atualizar o selo "Atrasada"
window.setInterval(() => {
    if (currentUser) renderizarTarefas();
}, 60000);
