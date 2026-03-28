const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

// --- CONFIGURAÇÃO MERCADO PAGO ---
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const payment = new Payment(client);

const app = express();
app.use(express.json());

// Liberta o acesso para o seu site do GitHub
app.use(cors({
    origin: '*' // Para evitar bloqueios no Render, permitimos todas as origens por enquanto
}));

// --- CONEXÃO COM O BANCO DE DADOS (AIVEN NUVEM) ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false } // Obrigatório para conectar no Aiven!
});

db.connect(err => {
    if (err) {
        console.error('Erro ao conectar ao MySQL na Nuvem:', err);
        return;
    }
    console.log('Conectado ao MySQL com sucesso na Nuvem!');

    // AGORA SÓ CRIA SE NÃO EXISTIR (SEM O DROP TABLE)
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS usuarios (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            senha VARCHAR(255) NOT NULL,
            plano VARCHAR(50) DEFAULT 'VIP',
            limites TEXT
        )
    `;
    
    db.query(createTableQuery, (err) => {
        if (err) console.error("Erro ao verificar/criar tabela:", err);
        else console.log("Estrutura do banco de dados verificada com sucesso!");
    });

    const adminEmail = 'tomasfeltel10@gmail.com';
    const adminSenhaRaw = 'Ften@512';

    const checkAdmin = "SELECT * FROM usuarios WHERE email = ?";
    db.query(checkAdmin, [adminEmail], async (err, results) => {
    if (results.length === 0) {
            const hash = await bcrypt.hash(adminSenhaRaw, 10);
            const insertAdmin = "INSERT INTO usuarios (nome, email, senha, plano, limites) VALUES (?, ?, ?, ?, ?)";
            db.query(insertAdmin, ['Admin Tomás', adminEmail, hash, 'LEGEND', '999'], (err) => {
                if (err) console.error("Erro ao criar admin:", err);
                else console.log("ADMIN CRIADO COM SUCESSO! Agora você pode logar.");
         });
        }
    });
});

// ROTA: VERIFICAR STATUS DO PAGAMENTO
app.get('/check-payment/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const response = await payment.get({ id });
        
        // Se o status for 'approved', o pagamento caiu!
        if (response.status === 'approved') {
            return res.json({ approved: true });
        }
        res.json({ approved: false });
    } catch (error) {
        res.status(500).json({ error: "Erro ao consultar pagamento" });
    }
});

// --- ROTA: GERAR PIX (CHECKOUT) ---
app.post('/generate-pix', async (req, res) => {
    const { nome, email, cpf, plano } = req.body;

    let valorCobrado = 14.90; 
    if (plano === 'Pro') valorCobrado = 29.90;
    if (plano === 'Legend') valorCobrado = 59.90;

    try {
        const body = {
            transaction_amount: valorCobrado,
            description: `Assinatura ProTech - Plano ${plano}`,
            payment_method_id: 'pix',
            payer: {
                email: email,
                first_name: nome,
                identification: {
                    type: 'CPF',
                    number: cpf
                }
            }
        };

        const response = await payment.create({ body });

        const qrCodeBase64 = response.point_of_interaction.transaction_data.qr_code_base64;
        const copiaECola = response.point_of_interaction.transaction_data.qr_code;

        res.json({
            success: true,
            qrCodeBase64: qrCodeBase64,
            qrCodeCopiaCola: copiaECola,
            paymentId: response.id 
        });

    } catch (error) {
        console.error("Erro ao gerar PIX no Mercado Pago:", error);
        res.status(500).json({ success: false, message: 'Erro ao gerar PIX' });
    }
});

// --- ROTA: CADASTRO (SIGNUP) ---
app.post('/signup', async (req, res) => {
    const { nome, email, senha, plan, limits } = req.body;

    try {
        const salt = await bcrypt.genSalt(10);
        const senhaHash = await bcrypt.hash(senha, salt);
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

        res.json({
            id: usuario.id,
            nome: usuario.nome,
            plan: usuario.plano,
            limits: typeof usuario.limites === 'string' ? JSON.parse(usuario.limites) : usuario.limites
        });
    });
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
// O Render exige process.env.PORT para saber em qual porta ligar o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`------------------------------------------`);
    console.log(`PROtech Server ONLINE - Porta ${PORT}`);
    console.log(`------------------------------------------`);
});