import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script to populate database with sample products
 * Generic Product model - can be motorcycles, laptops, or anything
 */
async function main() {
  console.log('🌱 Seeding database...');

  // Sample products (motorcycles for MotorShop example)
  const products = [
    {
      name: 'Yamaha Ego S 125',
      brand: 'Yamaha',
      category: 'Motorcycle',
      subcategory: 'Scooter',
      description: 'Popular 125cc scooter, great for city riding. Fuel efficient and easy to handle, suitable for daily commute in Klang Valley.',
      price: 5200,
      currency: 'MYR',
      sku: 'YAMAHA-EGO-S-125',
      images: ['https://example.com/motorshop/yamaha-ego-s-125.jpg'],
      tags: ['scooter', 'yamaha', 'ego', 'ego s', '125cc', 'automatic', 'commuter'],
      features: {
        model: 'Ego S 125',
        year: 2022,
        type: 'scooter',
        engineSize: 125,
        condition: 'used',
        locations: ['Puchong', 'Subang', 'PJ'],
        specifications: {
          engine: '125cc, single-cylinder',
          fuelSystem: 'Fuel injection',
          transmission: 'CVT automatic',
          fuelTank: '4.2L',
          weight: '95kg',
        },
        abs: false,
        ledHeadlamp: true,
        storage: 'Underseat storage',
      },
      inStock: true,
      stockCount: 3,
      active: true,
      popularity: 90,
    },
    {
      name: 'Yamaha Y15ZR',
      brand: 'Yamaha',
      category: 'Motorcycle',
      subcategory: 'Kapcai',
      description: 'Highly popular 150cc kapcai in Malaysia. Sporty look with good performance, suitable for young riders.',
      price: 8500,
      currency: 'MYR',
      sku: 'YAMAHA-Y15ZR',
      images: ['https://example.com/motorshop/yamaha-y15zr.jpg'],
      tags: ['kapcai', 'yamaha', 'y15', 'y15zr', '150cc', 'sport'],
      features: {
        model: 'Y15ZR',
        year: 2021,
        type: 'kapcai',
        engineSize: 150,
        condition: 'used',
        locations: ['Puchong', 'Shah Alam', 'KL'],
        specifications: {
          engine: '150cc, liquid-cooled',
          fuelSystem: 'Fuel injection',
          transmission: '5-speed manual',
          fuelTank: '4.2L',
          weight: '117kg',
        },
        abs: false,
        ledHeadlamp: true,
        digitalMeter: true,
      },
      inStock: true,
      stockCount: 2,
      active: true,
      popularity: 120,
    },
    {
      name: 'Honda RS150R',
      brand: 'Honda',
      category: 'Motorcycle',
      subcategory: 'Kapcai',
      description: 'Reliable 150cc kapcai from Honda, comfortable for daily use with good fuel economy and performance.',
      price: 7800,
      currency: 'MYR',
      sku: 'HONDA-RS150R',
      images: ['https://example.com/motorshop/honda-rs150r.jpg'],
      tags: ['kapcai', 'honda', 'rs150', '150cc', 'commuter'],
      features: {
        model: 'RS150R',
        year: 2020,
        type: 'kapcai',
        engineSize: 150,
        condition: 'used',
        locations: ['PJ', 'KL'],
        specifications: {
          engine: '149cc, liquid-cooled',
          fuelSystem: 'PGM-FI',
          transmission: '6-speed manual',
          fuelTank: '4.5L',
          weight: '123kg',
        },
        abs: false,
        ledHeadlamp: false,
        storage: 'Rear rack available',
      },
      inStock: true,
      stockCount: 1,
      active: true,
      popularity: 80,
    },
    {
      name: 'Yamaha NVX 155',
      brand: 'Yamaha',
      category: 'Motorcycle',
      subcategory: 'Scooter',
      description: 'Premium 155cc scooter with sporty design, good power and advanced features. Suitable for city and highway use.',
      price: 11500,
      currency: 'MYR',
      sku: 'YAMAHA-NVX-155',
      images: ['https://example.com/motorshop/yamaha-nvx-155.jpg'],
      tags: ['scooter', 'yamaha', 'nvx', '155cc', 'premium'],
      features: {
        model: 'NVX 155',
        year: 2023,
        type: 'scooter',
        engineSize: 155,
        condition: 'new',
        locations: ['Puchong', 'KL'],
        specifications: {
          engine: '155cc VVA',
          fuelSystem: 'Fuel injection',
          transmission: 'CVT automatic',
          fuelTank: '4.5L',
          weight: '122kg',
        },
        abs: true,
        ledHeadlamp: true,
        digitalMeter: true,
      },
      inStock: true,
      stockCount: 1,
      active: true,
      popularity: 60,
    },
    {
      name: 'Modenas Kriss 110',
      brand: 'Modenas',
      category: 'Motorcycle',
      subcategory: 'Kapcai',
      description: 'Affordable 110cc kapcai, very popular as a budget-friendly daily commuter with low maintenance cost.',
      price: 3500,
      currency: 'MYR',
      sku: 'MODENAS-KRISS-110',
      images: ['https://example.com/motorshop/modenas-kriss-110.jpg'],
      tags: ['kapcai', 'modenas', '110cc', 'budget', 'commuter'],
      features: {
        model: 'Kriss 110',
        year: 2019,
        type: 'kapcai',
        engineSize: 110,
        condition: 'used',
        locations: ['Puchong', 'Rawang'],
        specifications: {
          engine: '110cc, air-cooled',
          fuelSystem: 'Carburetor',
          transmission: '4-speed manual',
          fuelTank: '4.5L',
          weight: '95kg',
        },
        abs: false,
        ledHeadlamp: false,
      },
      inStock: true,
      stockCount: 2,
      active: true,
      popularity: 70,
    },
  ];

  // Create products
  for (const product of products) {
    await prisma.product.upsert({
      where: { sku: product.sku },
      update: product,
      create: product,
    });
    console.log(`✅ Created/Updated: ${product.name} (${product.brand})`);
  }

  console.log('✨ Seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
