// test-redis.js - Simple Redis connection test
import { createClient } from 'redis';

console.log('Testing Redis connection...');

// Test configuration 1: With TLS and rejectUnauthorized: false
async function testRedisConnection() {
    const client = createClient({
        username: 'default',
        password: 'QOW3nICCleevROcEWNnNqgR7V818GHJj',
        socket: {
            host: 'redis-18426.c328.europe-west3-1.gce.redns.redis-cloud.com',
            port: 18426,
            tls: true,
            rejectUnauthorized: false
        }
    });

    client.on('error', err => {
        console.log('Redis Client Error:', err.message);
    });

    client.on('connect', () => {
        console.log('Redis client connecting...');
    });

    client.on('ready', () => {
        console.log('Redis client ready');
    });

    try {
        await client.connect();
        console.log('✅ Successfully connected to Redis Cloud');
        
        // Test basic operations
        await client.set('test', 'Hello Redis!');
        const result = await client.get('test');
        console.log('✅ Test value retrieved:', result);
        
        await client.disconnect();
        console.log('✅ Disconnected from Redis');
    } catch (error) {
        console.error('❌ Failed to connect to Redis:', error.message);
        
        // Try alternative configuration without TLS
        console.log('\nTrying alternative configuration without TLS...');
        try {
            const client2 = createClient({
                username: 'default',
                password: 'QOW3nICCleevROcEWNnNqgR7V818GHJj',
                socket: {
                    host: 'redis-18426.c328.europe-west3-1.gce.redns.redis-cloud.com',
                    port: 18426
                }
            });
            
            await client2.connect();
            console.log('✅ Successfully connected to Redis without TLS');
            await client2.disconnect();
        } catch (error2) {
            console.error('❌ Alternative configuration also failed:', error2.message);
        }
    }
}

testRedisConnection(); 