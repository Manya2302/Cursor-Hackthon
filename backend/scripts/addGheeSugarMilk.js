/**
 * Add Ghee, Sugar, Milk to Product Master with quantity + price.
 * Usage: node scripts/addGheeSugarMilk.js [vendorPhone]
 * Default vendor phone: 918866686473 (Manya)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { createProduct, updatePrices } = require('../src/services/productMaster');

const VENDOR_PHONE = (process.argv[2] || '918866686473').replace(/\D/g, '');

const PRODUCTS = [
  { name: 'Ghee', unit: 'KG', stock: 10, selling_price: 550, category: 'Dairy' },
  { name: 'Sugar', unit: 'KG', stock: 35, selling_price: 45, category: 'Grains' },
  { name: 'Milk', unit: 'L', stock: 40, selling_price: 60, category: 'Dairy' },
];

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_API || '';
  if (!connectionString) {
    console.error('DATABASE_URL / SUPABASE_API not set');
    process.exit(1);
  }

  const pg = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  try {
    const vendorRes = await pg.query('select id, name from vendors where phone = $1', [
      VENDOR_PHONE,
    ]);
    const vendor = vendorRes.rows[0];
    if (!vendor) {
      console.error(`No vendor found with phone ${VENDOR_PHONE}`);
      process.exit(1);
    }
    console.log(`Vendor: ${vendor.name} (${vendor.id})`);

    for (const p of PRODUCTS) {
      const { product, created } = await createProduct(vendor.id, p);
      let final = product;
      if (!created) {
        final = await updatePrices(
          vendor.id,
          product.id,
          { selling_price: p.selling_price, stock: p.stock, unit: p.unit },
          { reason: 'manual_setup' }
        );
      }
      console.log(
        `${created ? 'Created' : 'Updated'}: ${final.product_name} — stock ${final.current_stock} ${final.unit}, sell ₹${final.selling_price}/${final.unit}`
      );
    }
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

main();
