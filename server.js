const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

// --- NOVAS BIBLIOTECAS PARA E-MAIL ---
const nodemailer = require('nodemailer');
const crypto = require('crypto');

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
        if (err) return console.error("Erro ao checar admin:", err);

        if (results.length === 0) {
            const hash = await bcrypt.hash(adminSenhaRaw, 10);
            const insertAdmin = "INSERT INTO usuarios (nome, email, senha, plano, limites) VALUES (?, ?, ?, ?, ?)";
        
            // Define o limite de 1 loja para o plano VIP (Starter)
            const limitesVIP = JSON.stringify({ stores: 1, items: 10 });

            db.query(insertAdmin, ['Admin Tomás', adminEmail, hash, 'VIP', limitesVIP], (err) => {
                if (err) console.error("Erro ao criar admin:", err);
                else console.log("ADMIN VIP CRIADO COM SUCESSO! Verde esmeralda ativado.");
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
    // 1. Lemos a variável 'plan' (que é exatamente a que o checkout envia)
    const { nome, email, cpf, plan } = req.body;

    // 2. Definimos os preços exatos por questões de segurança no servidor
    let valorCobrado = 14.90; // Valor padrão (VIP)
    if (plan === 'PRO') valorCobrado = 29.90;
    if (plan === 'LEGEND') valorCobrado = 59.90;

    try {
        const body = {
            transaction_amount: valorCobrado,
            description: `Assinatura ProTech - Plano ${plan || 'VIP'}`,
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

// --- ROTA: ESQUECI A SENHA (VIA BREVO API - FURA BLOQUEIO) ---
app.post('/forgot-password', (req, res) => {
    const { email } = req.body;

    const sql = "SELECT id, nome FROM usuarios WHERE email = ?";
    db.query(sql, [email], (err, result) => {
        if (err) {
            console.error("Erro ao buscar email:", err);
            return res.status(500).json({ success: false });
        }

        if (result.length > 0) {
            const usuario = result[0];
            const token = crypto.randomBytes(20).toString('hex');
            const expiracao = new Date(Date.now() + 3600000); 

            const updateSql = "UPDATE usuarios SET reset_token = ?, reset_token_expires = ? WHERE id = ?";
            db.query(updateSql, [token, expiracao, usuario.id], (updateErr) => {
                if (updateErr) {
                    console.error("Erro ao salvar token:", updateErr);
                    return; 
                }

                // URL para testes locais (quando mandar pro GitHub, troque pelo link real do seu site!)
                const resetLink = `http://127.0.0.1:5500/reset-password.html?token=${token}`;

                const emailData = {
                    sender: { name: "ProTech Lab", email: "protech.labmail@gmail.com" }, // ATENÇÃO: Tem de ser o e-mail que usou para criar a conta no Brevo
                    to: [{ email: email }],
                    subject: "Recuperação de Senha - ProTech Lab",
                    htmlContent: `
                        <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; background-color: #0b0b0b; color: #fff; padding: 40px; border-radius: 20px; border: 1px solid rgba(212, 175, 55, 0.2);">
                            <h2 style="color: #D4AF37; margin-top: 0;">Recuperação de Senha</h2>
                            <p style="color: #ccc; font-size: 15px;">Olá, <b>${usuario.nome}</b>,</p>
                            <p style="color: #ccc; font-size: 15px; line-height: 1.6;">Recebemos um pedido para redefinir a sua senha no painel da ProTech Lab.</p>
                            <p style="color: #ccc; font-size: 15px; line-height: 1.6;">Clique no botão abaixo para criar uma nova senha. <b>Este link é válido por 1 hora.</b></p>
                            
                            <div style="text-align: center; margin: 40px 0;">
                                <a href="${resetLink}" style="display: inline-block; background-color: #D4AF37; color: #000; padding: 15px 30px; text-decoration: none; font-weight: 800; border-radius: 12px; letter-spacing: 1px; text-transform: uppercase; font-size: 14px;">Redefinir Minha Senha</a>
                            </div>
                            
                            <p style="margin-top: 30px; font-size: 12px; color: #666; text-align: center; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 15px;">Se não foi você que solicitou, pode ignorar este e-mail em segurança.</p>
                        </div>
                    `
                };

                // AQUI É A MÁGICA QUE FURA O BLOQUEIO: Enviando via HTTP
                fetch('https://api.brevo.com/v3/smtp/email', {
                    method: 'POST',
                    headers: {
                        'accept': 'application/json',
                        'api-key': process.env.BREVO_API_KEY,
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify(emailData)
                })
                .then(resposta => resposta.json())
                .then(dados => console.log("E-mail disparado pelo Brevo com sucesso!", dados))
                .catch(erro => console.error("Erro na API do Brevo:", erro));
            });
        }

        res.status(200).json({ success: true, message: "Solicitação processada." });
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