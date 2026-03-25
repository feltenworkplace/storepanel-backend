const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIGURAÇÃO MERCADO PAGO ---
// [CRÍTICO]: Substitua SEU_ACCESS_TOKEN_AQUI pelo seu token real (TEST-... ou APP_USR-...)
const client = new MercadoPagoConfig({ accessToken: 'TEST-6126732693506794-031800-e58f9530a9b144f8746dad11c29b4e38-2146058938' });
const payment = new Payment(client);

// --- CONEXÃO COM O BANCO DE DADOS (XAMPP) ---
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'protech_db'
});

db.connect(err => {
    if (err) {
        console.error('Erro ao conectar ao MySQL:', err);
        return;
    }
    console.log('Conectado ao MySQL com sucesso!');
});

// --- ROTA: GERAR PIX (CHECKOUT) ---
app.post('/generate-pix', async (req, res) => {
    const { email, nome, sobrenome, cpf, plan } = req.body;
    const prices = { 'VIP': 14.90, 'PRO': 29.90, 'LEGEND': 59.90 };

    if (!prices[plan]) return res.status(400).json({ error: "Plano inválido" });

    const body = {
        transaction_amount: prices[plan],
        description: `Assinatura ProTech: ${plan}`,
        payment_method_id: 'pix',
        payer: {
            email: email,
            first_name: nome,
            last_name: sobrenome,
            identification: { type: 'CPF', number: cpf.replace(/\D/g, '') }
        }
    };

    try {
        // O segredo está aqui: pedindo uma chave única para ignorar o bloqueio anterior
        const requestOptions = { idempotencyKey: Date.now().toString() }; 
        
        const response = await payment.create({ body, requestOptions });
        
        res.json({
            qr_code: response.point_of_interaction.transaction_data.qr_code_base64,
            copy_paste: response.point_of_interaction.transaction_data.qr_code
        });
    } catch (error) {
        console.log("--- ERRO NO MERCADO PAGO ---");
        // Isso vai mostrar exatamente qual campo o MP não gostou no seu terminal
        if (error.response && error.response.body) {
            console.log("Causa:", JSON.stringify(error.response.body.cause, null, 2));
        } else {
            console.log("Mensagem:", error.message);
        }
        res.status(500).json({ error: "Erro ao gerar Pix" });
    }
});

// --- ROTA: CADASTRO (SIGNUP) ---
app.post('/signup', async (req, res) => {
    const { nome, email, senha, plan, limits } = req.body;

    try {
        const salt = await bcrypt.genSalt(10);
        const senhaHash = await bcrypt.hash(senha, salt);
        
        // Converte o objeto de limites em String para salvar no banco
        const limitesStr = JSON.stringify(limits);

        const sql = "INSERT INTO usuarios (nome, email, senha, plano, limites) VALUES (?, ?, ?, ?, ?)";
        db.query(sql, [nome, email, senhaHash, plan, limitesStr], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(400).send("E-mail já cadastrado!");
                return res.status(500).send(err);
            }
            res.status(201).send("Usuário cadastrado com sucesso!");
        });
    } catch (e) {
        res.status(500).send("Erro no servidor");
    }
});

// --- ROTA: LOGIN ---
app.post('/login', (req, res) => {
    const { email, senha } = req.body;

    const sql = "SELECT * FROM usuarios WHERE email = ?";
    db.query(sql, [email], async (err, result) => {
        if (err) return res.status(500).send(err);
        if (result.length === 0) return res.status(404).send("Usuário não encontrado!");

        const usuario = result[0];
        const senhaValida = await bcrypt.compare(senha, usuario.senha);
        
        if (!senhaValida) return res.status(401).send("Senha incorreta!");

        // Retorna os dados necessários para o Dashboard funcionar com as travas
        res.json({
            id: usuario.id,
            nome: usuario.nome,
            plan: usuario.plano,
            limits: typeof usuario.limites === 'string' ? JSON.parse(usuario.limites) : usuario.limites
        });
    });
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(3000, () => {
    console.log("------------------------------------------");
    console.log("PROtech Server ONLINE - Porta 3000");
    console.log("------------------------------------------");
});