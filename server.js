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
        else {
            console.log("Estrutura base verificada!");
            // MÁGICA: Adiciona a coluna 'lojas' se ela ainda não existir
            db.query("ALTER TABLE usuarios ADD COLUMN lojas LONGTEXT", (altErr) => {
                if (altErr && altErr.code !== 'ER_DUP_FIELDNAME') console.error("Erro ao adicionar coluna lojas:", altErr);
                else console.log("Pronto para guardar lojas na nuvem!");
            });
        }
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

    // 3. LIMPEZA DO CPF: Remove pontos e traços (Obrigatório para o Mercado Pago)
    const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : '';

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
                    number: cpfLimpo // Usa o CPF limpo aqui!
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

// --- ROTA: LOGIN (AIVEN) ---
app.post('/login', (req, res) => {
    // CORREÇÃO: Agora o backend procura por 'senha' em vez de 'password'
    const { email, senha } = req.body;
    
    // Garantia de segurança (caso venha password de algum outro lugar)
    const senhaRecebida = senha || req.body.password;

    const query = 'SELECT * FROM usuarios WHERE email = ?';
    db.query(query, [email], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Erro no servidor.' });
        if (results.length === 0) return res.status(401).json({ success: false, message: 'Usuário não encontrado.' });

        const user = results[0];
        bcrypt.compare(senhaRecebida, user.senha, (err, isMatch) => {
            if (err) return res.status(500).json({ success: false, message: 'Erro ao verificar senha.' });
            if (!isMatch) return res.status(401).json({ success: false, message: 'E-mail ou senha incorretos.' });

            // Devolvemos todos os dados do banco para o LocalStorage
            res.json({ 
                success: true, 
                message: 'Login bem-sucedido!',
                user: {
                    nome: user.nome,
                    email: user.email,
                    plano: user.plano,
                    limites: user.limites
                }
            });
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

                const resetLink = `https://feltenworkplace.github.io/protech-storepanel/reset-password.html?token=${token}`;

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

// --- ROTA: REDEFINIR A SENHA (GRAVAR A NOVA SENHA) ---
app.post('/reset-password', async (req, res) => {
    const { token, novaSenha } = req.body;

    // 1. Procura o utilizador que tem este token exato e verifica se ainda não expirou
    const sqlBusca = "SELECT id FROM usuarios WHERE reset_token = ? AND reset_token_expires > NOW()";
    
    db.query(sqlBusca, [token], async (err, result) => {
        if (err) return res.status(500).json({ success: false, message: "Erro no servidor." });
        
        if (result.length === 0) {
            return res.status(400).json({ success: false, message: "O link expirou ou é inválido. Peça um novo e-mail." });
        }

        const usuarioId = result[0].id;

        try {
            // 2. Encripta a senha nova
            const salt = await bcrypt.genSalt(10);
            const senhaHash = await bcrypt.hash(novaSenha, salt);

            // 3. Atualiza a senha no banco e apaga o token (para não ser usado 2 vezes)
            const sqlAtualiza = "UPDATE usuarios SET senha = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?";
            
            db.query(sqlAtualiza, [senhaHash, usuarioId], (updateErr) => {
                if (updateErr) return res.status(500).json({ success: false, message: "Erro ao salvar a senha." });
                
                res.json({ success: true, message: "Senha atualizada com sucesso!" });
            });

        } catch (error) {
            res.status(500).json({ success: false, message: "Erro ao encriptar a senha." });
        }
    });
});

// --- ROTA: VERIFICAR STATUS DO PAGAMENTO REAL ---
app.post('/check-payment', async (req, res) => {
    const { paymentId, lojaToken } = req.body;
    
    try {
        // Usa a chave exata do dono da loja para ir ao Mercado Pago
        const client = new MercadoPagoConfig({ accessToken: lojaToken || process.env.MP_ACCESS_TOKEN });
        const payment = new Payment(client);
        
        const response = await payment.get({ id: paymentId });
        
        // Se o banco disser que está aprovado, a gente avisa o site!
        if (response.status === 'approved') {
            return res.json({ approved: true });
        }
        res.json({ approved: false });
    } catch (error) {
        res.json({ approved: false, error: "Aguardando confirmação do banco..." });
    }
});

// --- ROTA: GERAR PIX (MERCADO PAGO) ---
app.post('/create-pix', async (req, res) => {
    const { lojaToken, cliente, valor, itens } = req.body;

    // 1. Verifica se a loja configurou o token
    if (!lojaToken) {
        return res.status(400).json({ success: false, message: "A loja não possui um Token do Mercado Pago configurado." });
    }

    try {
        // 2. Configura o Mercado Pago com o TOKEN DA LOJA ESPECÍFICA!
        // É isso que garante que o dinheiro vai para a conta do seu cliente, e não para a sua.
        const client = new MercadoPagoConfig({ accessToken: lojaToken });
        const payment = new Payment(client);

        // 3. Limpa o CPF (O Mercado Pago só aceita números)
        const cpfLimpo = cliente.cpf.replace(/\D/g, '');

        // 4. Monta os dados da cobrança
        const paymentData = {
            transaction_amount: Number(valor),
            description: `Pedido ProTech (${itens.length} itens)`,
            payment_method_id: 'pix',
            payer: {
                email: cliente.email,
                first_name: cliente.nome,
                identification: {
                    type: 'CPF',
                    number: cpfLimpo
                }
            }
        };

        // 5. Envia o pedido para o Mercado Pago
        const result = await payment.create({ body: paymentData });

        // 6. Retorna o QR Code (Imagem) e o código Copia e Cola para o site
        res.json({
            success: true,
            qr_code: result.point_of_interaction.transaction_data.qr_code,
            qr_code_base64: result.point_of_interaction.transaction_data.qr_code_base64,
            payment_id: result.id
        });

    } catch (error) {
        console.error("Erro no Mercado Pago:", error);
        res.status(500).json({ success: false, message: "Erro ao gerar o PIX no Mercado Pago. Verifique se o Token é válido." });
    }
});

// --- ROTA: PEGAR LOJAS DA NUVEM ---
app.post('/get-stores', (req, res) => {
    const { email } = req.body;
    db.query("SELECT lojas FROM usuarios WHERE email = ?", [email], (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err });
        if (results.length === 0) return res.status(404).json({ success: false, message: "Usuário não encontrado" });
        
        // Retorna as lojas (se estiver vazio, retorna um array vazio)
        res.json({ success: true, lojas: results[0].lojas ? JSON.parse(results[0].lojas) : [] });
    });
});

// --- ROTA: SALVAR LOJAS NA NUVEM (SYNC) ---
app.post('/sync-stores', (req, res) => {
    const { email, stores } = req.body;
    const storesStr = JSON.stringify(stores);
    
    db.query("UPDATE usuarios SET lojas = ? WHERE email = ?", [storesStr, email], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err });
        res.json({ success: true });
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