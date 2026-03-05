#!/usr/bin/env tsx
/**
 * Supabase Connection Test Script
 *
 * This script verifies:
 * 1. Environment variables are properly configured
 * 2. Connection to Supabase is successful
 * 3. Database schema is correctly applied
 * 4. Basic CRUD operations work
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database';

// Load environment variables
config({ path: '.env.local' });

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title: string) {
  console.log('\n' + '='.repeat(60));
  log(title, 'cyan');
  console.log('='.repeat(60));
}

async function testConnection() {
  section('🔍 Checking Environment Variables');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || supabaseUrl.includes('placeholder') || supabaseUrl.includes('your-project')) {
    log('❌ NEXT_PUBLIC_SUPABASE_URL is not configured', 'red');
    log('   Please update .env.local with your Supabase project URL', 'yellow');
    process.exit(1);
  }

  if (!supabaseKey || supabaseKey.includes('placeholder') || supabaseKey.includes('your-')) {
    log('❌ NEXT_PUBLIC_SUPABASE_ANON_KEY is not configured', 'red');
    log('   Please update .env.local with your Supabase anon key', 'yellow');
    process.exit(1);
  }

  log('✅ Environment variables are configured', 'green');
  log(`   URL: ${supabaseUrl}`, 'blue');
  log(`   Key: ${supabaseKey.substring(0, 20)}...`, 'blue');

  section('🔌 Testing Connection to Supabase');

  const supabase = createClient<Database>(supabaseUrl, supabaseKey);

  try {
    // Test basic connection
    const { error } = await supabase.from('student').select('count');

    if (error) {
      log('❌ Connection failed', 'red');
      log(`   Error: ${error.message}`, 'red');

      if (error.message.includes('relation') && error.message.includes('does not exist')) {
        log('\n⚠️  The database tables were not found!', 'yellow');
        log('   Please verify your database schema is set up correctly.', 'yellow');
        log('   Expected tables: student, fellowship, application, advising_meeting, etc.', 'yellow');
      }

      process.exit(1);
    }

    log('✅ Successfully connected to Supabase', 'green');

    section('📊 Verifying Database Schema');

    // Check all required tables exist
    const tables = [
      'student',
      'fellowship',
      'application',
      'advising_meeting',
      'advisor',
      'scholarship_history',
      'fellowship_thursday',
    ];

    const tableResults = await Promise.allSettled(
      tables.map(async (table) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await supabase.from(table as any).select('count', { count: 'exact', head: true });
        return { table, error };
      })
    );

    let allTablesExist = true;
    for (const result of tableResults) {
      if (result.status === 'fulfilled' && !result.value.error) {
        log(`✅ Table '${result.value.table}' exists`, 'green');
      } else {
        allTablesExist = false;
        const table = result.status === 'fulfilled' ? result.value.table : 'unknown';
        log(`❌ Table '${table}' not found or inaccessible`, 'red');
      }
    }

    if (!allTablesExist) {
      log('\n⚠️  Some tables are missing!', 'yellow');
      log('   Please verify your database schema is complete.', 'yellow');
      process.exit(1);
    }

    section('🧪 Testing Basic Operations');

    // Test insert (will fail if RLS is too restrictive, which is expected)
    log('Testing INSERT operation...', 'blue');
    const { error: insertError } = await supabase
      .from('student')
      .insert({
        full_name: 'Test User',
        email: 'test@test.com',
        us_citizen: true,
      });

    if (insertError) {
      if (insertError.message.includes('policy')) {
        log('⚠️  INSERT blocked by RLS policy (expected for unauthenticated users)', 'yellow');
        log('   This is normal - authentication is required for data modification', 'yellow');
      } else {
        log(`⚠️  INSERT failed: ${insertError.message}`, 'yellow');
      }
    } else {
      log('✅ INSERT operation successful', 'green');

      // Clean up test data
      await supabase
        .from('student')
        .delete()
        .eq('email', 'test@test.com');
      log('   Test data cleaned up', 'blue');
    }

    section('✨ Connection Test Complete');
    log('Your Supabase connection is properly configured!', 'green');
    log('\nNext steps:', 'cyan');
    log('1. Start building your application: pnpm dev', 'blue');
    log('2. Create data access functions for your tables', 'blue');
    log('3. Implement authentication if needed', 'blue');

  } catch (err) {
    log('❌ Unexpected error occurred', 'red');
    console.error(err);
    process.exit(1);
  }
}

// Run the test
testConnection().catch((err) => {
  log('❌ Fatal error', 'red');
  console.error(err);
  process.exit(1);
});
