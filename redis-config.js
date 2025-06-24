// redis-config.js - Redis connection configurations
import { createClient } from 'redis';

// Configuration 1: With TLS and rejectUnauthorized: false (current)
export const redisConfig1 = {
    username: 'default',
    password: 'QOW3nICCleevROcEWNnNqgR7V818GHJj',
    socket: {
        host: 'redis-18426.c328.europe-west3-1.gce.redns.redis-cloud.com',
        port: 18426,
        tls: true,
        rejectUnauthorized: false
    }
};

// Configuration 2: Without TLS (alternative)
export const redisConfig2 = {
    username: 'default',
    password: 'QOW3nICCleevROcEWNnNqgR7V818GHJj',
    socket: {
        host: 'redis-18426.c328.europe-west3-1.gce.redns.redis-cloud.com',
        port: 18426
    }
};

// Configuration 3: With TLS but different options
export const redisConfig3 = {
    username: 'default',
    password: 'QOW3nICCleevROcEWNnNqgR7V818GHJj',
    socket: {
        host: 'redis-18426.c328.europe-west3-1.gce.redns.redis-cloud.com',
        port: 18426,
        tls: {
            rejectUnauthorized: false,
            servername: 'redis-18426.c328.europe-west3-1.gce.redns.redis-cloud.com'
        }
    }
};

// Function to create Redis client with fallback configurations
export async function createRedisClientWithFallback() {
    const configs = [redisConfig1, redisConfig2, redisConfig3];
    
    for (let i = 0; i < configs.length; i++) {
        try {
            console.log(`Trying Redis configuration ${i + 1}...`);
            const client = createClient(configs[i]);
            
            client.on('error', err => {
                console.log(`Redis Client Error (config ${i + 1}):`, err.message);
            });

            client.on('connect', () => {
                console.log(`Redis client connecting (config ${i + 1})...`);
            });

            client.on('ready', () => {
                console.log(`Redis client ready (config ${i + 1})`);
            });

            await client.connect();
            console.log(`✅ Successfully connected with configuration ${i + 1}`);
            
            // Test basic operation
            await client.set('test', 'Hello Redis!');
            const result = await client.get('test');
            console.log('✅ Test successful:', result);
            
            return client;
        } catch (error) {
            console.error(`❌ Configuration ${i + 1} failed:`, error.message);
            if (i === configs.length - 1) {
                console.log('All Redis configurations failed. Continuing without Redis cache.');
                return null;
            }
        }
    }
}

// Export the default configuration (currently config1)
export const defaultRedisConfig = redisConfig1; 