const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const postgres = require('postgres');
const cors = require('cors');
const path = require('path');
const { MercadoPagoConfig, Payment } = require('mercadopago');

// CONFIGURAÇÃO DO SUPABASE (POSTGRESQL)
    const postgres = require('postgres');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:%40G1hh4ej22d@db.qxhpcaqdymiwsdloumma.supabase.co:5432/postgres';
const sql = postgres(connectionString, { 
    ssl: 'require',
    host: 'db.qxhpcaqdymiwsdloumma.supabase.co',
    port: 5432,
    database: 'postgres',
    username: 'postgres',
    password: '@G1hh4ej22d',
    family: 4
});

// Testar conexão ao iniciar
async function testarConexao() {
    try {
        const result = await sql`SELECT NOW()`;
        console.log('Conectado ao Supabase (PostgreSQL) com sucesso!', result[0].now);
    } catch (err) {
        console.error('Erro ao conectar ao Supabase:', err.message);
    }
}
testarConexao();

// CONFIGURAÇÃO DO MERCADO PAGO COM O SEU TOKEN FUNCIONAL
const client = new MercadoPagoConfig({ accessToken: "APP_USR-2095945046166753-082622-da2e84ef00479fd4c8e21ca7382f08b0-71867761" });
const payment = new Payment(client);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Conexão do Socket.io para avisar o front-end em tempo real
io.on('connection', (socket) => {
  console.log('Cliente conectado via WebSocket no PDV:', socket.id);
});

// Criar tabelas e estrutura inicial no Supabase de forma assíncrona segura
async function inicializarBanco() {
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                code TEXT UNIQUE,
                name TEXT,
                unit TEXT,
                price REAL,
                stock INTEGER DEFAULT 0
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS estoque_movimentacoes (
                id SERIAL PRIMARY KEY,
                produto_codigo TEXT NOT NULL,
                produto_descricao TEXT NOT NULL,
                tipo TEXT NOT NULL,
                quantidade INTEGER NOT NULL,
                motivo TEXT,
                data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS sales (
                id SERIAL PRIMARY KEY,
                total REAL,
                payment_method TEXT,
                client_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS sale_items (
                id SERIAL PRIMARY KEY,
                sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
                product_code TEXT,
                product_name TEXT,
                quantity REAL,
                price REAL,
                total REAL
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS clients (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                address TEXT,
                number TEXT,
                whatsapp TEXT,
                phone TEXT,
                debt REAL DEFAULT 0
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS cash_register (
                id SERIAL PRIMARY KEY,
                type TEXT,
                amount REAL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS caixa_movimentacoes (
                id SERIAL PRIMARY KEY,
                tipo TEXT,
                valor REAL,
                motivo TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;

        // Inserir produtos padrão caso a tabela esteja vazia
        const produtosExistentes = await sql`SELECT COUNT(*) as count FROM products`;
        if (produtosExistentes[0].count === '0' || produtosExistentes[0].count === 0) {
            await sql`
                INSERT INTO products (code, name, unit, price, stock) VALUES 
                ('7891001', 'Coca-Cola 2L', 'UN', 10.00, 10),
                ('7891002', 'Pão Frances (Kg)', 'KG', 20.00, 10),
                ('7891003', 'Arroz Tio João 5kg', 'UN', 28.50, 10),
                ('7891004', 'Leite Integral 1L', 'UN', 5.49, 10)
            `;
            console.log('Produtos iniciais inseridos com sucesso!');
        }

        console.log('Tabelas do Supabase verificadas/criadas com sucesso!');
    } catch (err) {
        console.error('Erro ao inicializar tabelas no Supabase:', err.message);
    }
}
inicializarBanco();

// Rota para puxar o painel de estoque e o histórico unificado
app.get('/api/estoque/painel', async (req, res) => {
    try {
        const produtos = await sql`SELECT code as codigo, name as descricao, stock as estoque, price as preco FROM products`;
        const movimentacoes = await sql`SELECT * FROM estoque_movimentacoes ORDER BY data_hora DESC LIMIT 50`;
        res.json({ produtos: produtos || [], movimentacoes: movimentacoes || [] });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

// Rota para registrar entradas ou ajustes manuais no estoque
app.post('/api/estoque/movimentar', async (req, res) => {
    const { codigo, tipo, quantidade, motivo } = req.body;
    const qtdNum = parseInt(quantidade) || 0;

    try {
        const produtos = await sql`SELECT * FROM products WHERE code = ${codigo}`;
        if (!produtos || produtos.length === 0) {
            return res.status(404).json({ erro: "Produto não encontrado com este código!" });
        }

        const produto = produtos[0];
        const qtdAtual = produto.stock || 0;
        const novaQtd = tipo === 'ENTRADA' ? qtdAtual + qtdNum : qtdAtual - qtdNum;

        if (novaQtd < 0) {
            return res.status(400).json({ erro: "Estoque insuficiente para esta saída!" });
        }

        await sql`UPDATE products SET stock = ${novaQtd} WHERE code = ${codigo}`;
        await sql`
            INSERT INTO estoque_movimentacoes (produto_codigo, produto_descricao, tipo, quantidade, motivo) 
            VALUES (${codigo}, ${produto.name}, ${tipo}, ${qtdNum}, ${motivo || 'Reposição Manual'})
        `;

        res.json({ sucesso: true, novoEstoque: novaQtd });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

// Rotas de Produtos
app.post('/api/products', async (req, res) => {
    const { code, name, unit, price } = req.body;
    try {
        const resultado = await sql`
            INSERT INTO products (code, name, unit, price, stock) 
            VALUES (${code}, ${name}, ${unit}, ${price}, 0) 
            RETURNING id
        `;
        res.json({ success: true, id: resultado[0].id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Rota para listar clientes com seus respectivos itens em fiado
app.get('/api/clients', async (req, res) => {
    try {
        const clients = await sql`SELECT * FROM clients`;

        const enrichedClients = await Promise.all(clients.map(async (client) => {
            const items = await sql`
                SELECT si.product_name, si.quantity, si.price, si.total 
                FROM sale_items si 
                JOIN sales s ON si.sale_id = s.id 
                WHERE s.client_id = ${client.id} AND s.payment_method ILIKE '%Fiado%'
            `;
            client.items = items || [];
            return client;
        }));

        res.json(enrichedClients);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rota para cadastrar novo cliente
app.post('/api/clients', async (req, res) => {
    const { name, address, number, whatsapp, phone } = req.body;
    try {
        const resultado = await sql`
            INSERT INTO clients (name, address, number, whatsapp, phone, debt) 
            VALUES (${name}, ${address || ''}, ${number || ''}, ${whatsapp || ''}, ${phone || ''}, 0) 
            RETURNING id
        `;
        res.json({ success: true, id: resultado[0].id, name, address, number, whatsapp });
    } catch (err) {
        console.error("Erro ao inserir cliente:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Rota para excluir cliente
app.delete('/api/clients/:id', async (req, res) => {
    const clientId = req.params.id;
    try {
        const resultado = await sql`DELETE FROM clients WHERE id = ${clientId}`;
        res.json({ message: "Cliente excluído com sucesso", changes: resultado.count });
    } catch (err) {
        console.error("Erro ao excluir cliente:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/products', async (req, res) => {
    try {
        const rows = await sql`SELECT code, name, unit, price, stock FROM products`;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/products/:code', async (req, res) => {
    try {
        const rows = await sql`SELECT * FROM products WHERE code = ${req.params.code}`;
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ error: "Produto não encontrado" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rota de Vendas (Salvando o ID do cliente para vincular os produtos fiados)
app.post('/api/sales', async (req, res) => {
    const { items, total, paymentMethod, clientId } = req.body;

    try {
        if (paymentMethod && (paymentMethod.includes('Fiado') || paymentMethod === "Fiado (Anotar)") && clientId) {
            await sql`UPDATE clients SET debt = COALESCE(debt, 0) + ${total} WHERE id = ${clientId}`;
        }

        const saleResult = await sql`
            INSERT INTO sales (total, payment_method, client_id) 
            VALUES (${total}, ${paymentMethod}, ${clientId || null}) 
            RETURNING id
        `;
        const saleId = saleResult[0].id;

        if (items && Array.isArray(items)) {
            for (const item of items) {
                await sql`
                    INSERT INTO sale_items (sale_id, product_code, product_name, quantity, price, total) 
                    VALUES (${saleId}, ${item.code}, ${item.name}, ${item.quantity}, ${item.price}, ${item.total})
                `;

                // Dar baixa automática no estoque e registrar a saída no histórico
                await sql`UPDATE products SET stock = GREATEST(0, COALESCE(stock, 0) - ${item.quantity}) WHERE code = ${item.code}`;
                await sql`
                    INSERT INTO estoque_movimentacoes (produto_codigo, produto_descricao, tipo, quantidade, motivo) 
                    VALUES (${item.code}, ${item.name}, 'SAIDA', ${item.quantity}, ${'Venda PDV (Ref #' + saleId + ')'})
                `;
            }
        }

        res.json({ success: true, saleId: saleId, message: "Venda registrada com sucesso!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sales', async (req, res) => {
    try {
        const rows = await sql`SELECT * FROM sales ORDER BY created_at DESC`;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rota para limpar o histórico de vendas
app.delete('/api/sales', async (req, res) => {
    try {
        await sql`DELETE FROM sale_items`;
        const resultado = await sql`DELETE FROM sales`;
        res.json({ message: "Histórico limpo com sucesso", changes: resultado.count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rota para o resumo e o extrato completo do caixa
app.get('/api/caixa/resumo', async (req, res) => {
    try {
        const movimentacoes = await sql`SELECT * FROM caixa_movimentacoes ORDER BY id DESC`;
        const vendas = await sql`SELECT payment_method, total FROM sales`;

        let totalDinheiroVendas = 0;
        let totalPixVendas = 0;
        let totalFiadoVendas = 0;
        let totalDebitoVendas = 0;
        let totalCreditoVendas = 0;

        vendas.forEach(v => {
            const valor = parseFloat(v.total) || 0;
            const metodo = (v.payment_method || '').toUpperCase();
            
            if (metodo.includes('DINHEIRO')) {
                totalDinheiroVendas += valor;
            } else if (metodo.includes('PIX')) {
                totalPixVendas += valor;
            } else if (metodo.includes('FIADO') || metodo.includes('ANOTAR')) {
                totalFiadoVendas += valor;
            } else if (metodo.includes('DÉBITO') || metodo.includes('DEBITO')) {
                totalDebitoVendas += valor;
            } else if (metodo.includes('CRÉDITO') || metodo.includes('CREDITO')) {
                totalCreditoVendas += valor;
            } else {
                totalDinheiroVendas += valor;
            }
        });

        let totalEntradasManuais = 0;
        let totalSaidasManuais = 0;

        movimentacoes.forEach(m => {
            const val = parseFloat(m.valor) || 0;
            const tipo = (m.tipo || '').toUpperCase();
            if (tipo.includes('ABERTURA') || tipo.includes('SUPRIMENTO')) {
                totalEntradasManuais += val;
            } else if (tipo.includes('SANGRIA') || tipo.includes('RETIRADA')) {
                totalSaidasManuais += val;
            }
        });

        const totalVendasGeral = totalDinheiroVendas + totalPixVendas + totalDebitoVendas + totalCreditoVendas;
        const totalEntradasGerais = totalEntradasManuais + totalVendasGeral;
        const dinheiroFisicoEmCaixa = (totalEntradasManuais + totalDinheiroVendas) - totalSaidasManuais;
        const saldoEmCaixa = dinheiroFisicoEmCaixa;

        res.json({
            saldoEmCaixa: saldoEmCaixa,
            totalEntradas: totalEntradasGerais,
            totalSaidas: totalSaidasManuais,
            vendasDinheiro: totalDinheiroVendas,
            vendasPix: totalPixVendas,
            vendasFiado: totalFiadoVendas,
            vendasDebito: totalDebitoVendas,
            vendasCredito: totalCreditoVendas,
            movimentacoes: movimentacoes || []
        });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

// Rota de Webhook atualizada para o padrão funcional
app.post('/api/webhook', async (req, res) => {
    try {
        const { type, data } = req.body;
        const paymentId = data ? data.id : req.body.id;

        if (paymentId) {
            const paymentData = await payment.get({ id: paymentId });
            
            if (paymentData.status === 'approved') {
                const valor = paymentData.transaction_amount;
                console.log(`Pagamento ${paymentId} APROVADO via Webhook! Avisando o PDV...`);
                io.emit('pagamento_confirmado', { id: String(paymentId), valor: valor });
            }
        }
    } catch (err) {
        console.error('Erro ao processar webhook:', err);
    }
    res.sendStatus(200);
});

// Rota para atualizar o estoque e dados dos produtos em lote com senha
app.put('/api/estoque/atualizar-lote', async (req, res) => {
    const { senha, produtos } = req.body;
    if (senha !== '2332') {
        return res.status(403).json({ error: "Senha incorreta!" });
    }
    if (!produtos || !Array.isArray(produtos)) {
        return res.status(400).json({ error: "Dados inválidos!" });
    }

    try {
        for (const p of produtos) {
            await sql`UPDATE products SET name = ${p.name}, stock = ${p.stock} WHERE code = ${p.code}`;
        }
        res.json({ success: true, message: "Estoque atualizado com sucesso!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rota para zerar o caixa e histórico de movimentações com senha
app.delete('/api/caixa/zerar', async (req, res) => {
    const { senha } = req.body;
    if (senha !== '2332') {
        return res.status(403).json({ error: "Senha incorreta!" });
    }
    try {
        await sql`DELETE FROM caixa_movimentacoes`;
        res.json({ success: true, message: "Caixa zerado com sucesso!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/cash/summary', async (req, res) => {
    try {
        const salesRows = await sql`SELECT payment_method, SUM(total) as total FROM sales GROUP BY payment_method`;
        const cashRows = await sql`SELECT * FROM cash_register ORDER BY created_at DESC`;
        res.json({ salesSummary: salesRows, cashMovements: cashRows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rota para registrar movimentações manuais do caixa (Abertura, Sangria, Suprimento)
app.post('/api/caixa/movimentar', async (req, res) => {
    const { tipo, valor, motivo } = req.body;
    try {
        const resultado = await sql`
            INSERT INTO caixa_movimentacoes (tipo, valor, motivo) 
            VALUES (${tipo}, ${valor}, ${motivo || ''}) 
            RETURNING id
        `;
        res.json({ sucesso: true, id: resultado[0].id });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

// Rotas de Caixa
app.post('/api/cash', async (req, res) => {
    const { type, amount, description } = req.body;
    try {
        const resultado = await sql`
            INSERT INTO cash_register (type, amount, description) 
            VALUES (${type}, ${amount}, ${description || ''}) 
            RETURNING id
        `;
        res.json({ success: true, id: resultado[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rota de PIX Oficial (Mercado Pago)
app.post('/api/pix/create', async (req, res) => {
    const { transaction_amount } = req.body;
    try {
        const body = {
            transaction_amount: Number(transaction_amount),
            description: 'Pagamento via Pix - PDV Expresso',
            payment_method_id: 'pix',
            payer: { email: 'comprador@pdv.com', first_name: 'Cliente', last_name: 'PDV', identification: { type: 'CPF', number: '12345678909' } }
        };
        const response = await payment.create({ body });
        res.json({
            success: true,
            qr_code: response.point_of_interaction.transaction_data.qr_code,
            qr_code_base64: response.point_of_interaction.transaction_data.qr_code_base64,
            payment_id: response.id
        });
    } catch (error) {
        console.error('Erro ao gerar Pix no Mercado Pago:', error);
        res.status(500).json({ error: error.message || 'Erro ao gerar Pix.' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando com sucesso em http://localhost:${PORT}`);
});