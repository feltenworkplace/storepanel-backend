const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const payment = new Payment(client);

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

db.connect(err => {
    if (err) {
        console.error('Erro ao conectar ao MySQL na Nuvem:', err);
        return;
    }
    console.log('Conectado ao MySQL com sucesso na Nuvem!');
});

app.post('/generate-pix', async (req, res) => {
    const { nome, email, cpf, plano } = req.body;
    let valorCobrado = 29.90; 
    if (plano === 'Pro') valorCobrado = 49.90;
    if (plano === 'Legend') valorCobrado = 59.90;

    try {
        const body = {
            transaction_amount: valorCobrado,
            description: `Assinatura ProTech - Plano ${plano}`,
            payment_method_id: 'pix',
            payer: {
                email: email,
                first_name: nome,
                identification: { type: 'CPF', number: cpf }
            }
        };
        const response = await payment.create({ body });
        res.json({
            success: true,
            qrCodeBase64: response.point_of_interaction.transaction_data.qr_code_base64,
            qrCodeCopiaCola: response.point_of_interaction.transaction_data.qr_code,
            paymentId: response.id 
        });
    } catch (error) {
        console.error("Erro no Mercado Pago:", error);
        res.status(500).json({ success: false });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`PROtech Server ONLINE - Porta ${PORT}`);
});
