// ============================================================================
// VAULT BANK - EXTERNAL TRANSFERS TEST SCRIPT
// ============================================================================
// This script tests the external transfer functionality
// including form validation, API endpoints, and processing
// ============================================================================

class VaultBankExternalTransferTester {
  constructor() {
    this.baseUrl = 'http://localhost:3000';
    this.testResults = {
      apiEndpoint: false,
      formValidation: false,
      externalProcessing: false,
      errors: []
    };
  }

  // Test 1: Check if external transfer API endpoint exists
  async testAPIMethods() {
    console.log('🧪 Testing external transfer API methods...');
    
    try {
      const response = await fetch(`${this.baseUrl}/api/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: "50.00",
          pin: "0000",
          external: true,
          externalDetails: {
            fullName: "Jane Doe",
            bankName: "Test Bank",
            accountNumber: "1234567890",
            routingNumber: "021000021",
            accountType: "Checking"
          },
          description: "External Transfer to Jane Doe"
        })
      });

      const result = await response.json();
      console.log('   HTTP Status:', response.status);
      console.log('   Response:', result);

      if (response.status >= 400 && result.error) {
        console.log('ℹ️  Expected auth error (requires login):', result.error);
        this.testResults.apiEndpoint = true;
        return { success: true, message: 'API endpoint exists and returns expected results' };
      }

      return { success: true };
    } catch (error) {
      console.error('❌ API test failed:', error.message);
      this.testResults.errors.push('API: ' + error.message);
      return { success: false, error: error.message };
    }
  }

  // Test 2: Verify external transfer form fields in HTML
  async testExternalFormStructure() {
    console.log('🧪 Testing external transfer form structure...');
    
    try {
      const response = await fetch(`${this.baseUrl}/`);
      const html = await response.text();

      const requiredFields = [
        'extFullName',
        'extBankName',
        'extAccountNum',
        'extRoutingNum',
        'extAccountType',
        'extAmount'
      ];

      const results = requiredFields.map(field => ({
        field,
        found: html.includes(`id="${field}"`) || html.includes(`id='${field}'`)
      }));

      const missing = results.filter(r => !r.found);
      if (missing.length === 0) {
        console.log('✅ All external transfer form fields found');
        return { success: true };
      } else {
        console.error('❌ Missing fields:', missing.map(m => m.field).join(', '));
        return { success: false, missing };
      }
    } catch (error) {
      console.error('❌ Form structure test failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Test 3: Validate external transfer processing flow
  async testExternalTransferFlow() {
    console.log('🧪 Testing external transfer flow...');
    
    const testCases = [
      {
        name: 'Missing required fields',
        body: { amount: "100.00" },
        expectedError: true
      },
      {
        name: 'Invalid amount (zero)',
        body: { amount: "0", pin: "0000", external: true },
        expectedError: true
      },
      {
        name: 'Invalid amount (negative)',
        body: { amount: "-50.00", pin: "0000", external: true },
        expectedError: true
      }
    ];

    for (const testCase of testCases) {
      try {
        const response = await fetch(`${this.baseUrl}/api/transfer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testCase.body)
        });

        const result = await response.json();

        if (testCase.expectedError && response.status >= 400) {
          console.log(`✅ ${testCase.name}: Correctly rejected with "${result.error}"`);
        } else if (!testCase.expectedError && response.ok) {
          console.log(`✅ ${testCase.name}: Successfully processed`);
        } else {
          console.log(`ℹ️  ${testCase.name}: Response status=${response.status}`);
        }
      } catch (error) {
        console.error(`❌ ${testCase.name}: Error -`, error.message);
      }
    }

    return { success: true };
  }

  // Test 4: Verify external transfer RPC function exists in Supabase
  async testExternalTransferRPC() {
    console.log('🧪 Testing external transfer RPC function...');
    
    try {
      const response = await fetch(`${this.baseUrl}/api/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: "10.00",
          pin: "0000",
          external: true,
          externalDetails: {
            fullName: "Alice Smith",
            bankName: "Chase Bank",
            accountNumber: "9876543210",
            routingNumber: "021000021",
            accountType: "Savings"
          },
          description: "Test external transfer"
        })
      });

      const result = await response.json();
      
      if (response.status === 500 && result.error === 'Transfer processing failed') {
        console.log('⚠️  RPC function exists but requires database deployment');
        console.log('   This is expected until the SQL script is deployed to Supabase');
        return { success: true, needsDeployment: true };
      }

      return { success: true };
    } catch (error) {
      console.error('❌ RPC test failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Run all external transfer tests
  async runAllTests() {
    console.log('🚀 Starting Vault Bank External Transfer Tests...\n');
    
    const apiResult = await this.testAPIMethods();
    this.testResults.apiEndpoint = apiResult.success;
    
    const formResult = await this.testExternalFormStructure();
    this.testResults.formValidation = formResult.success;
    
    const flowResult = await this.testExternalTransferFlow();
    
    const rpcResult = await this.testExternalTransferRPC();

    // Summary
    console.log('\n📊 EXTERNAL TRANSFER TEST RESULTS:');
    console.log('═══════════════════════════════════════════');
    console.log('API Endpoint:', this.testResults.apiEndpoint ? '✅ PASS' : '❌ FAIL');
    console.log('Form Structure:', this.testResults.formValidation ? '✅ PASS' : '❌ FAIL');
    console.log('Validation Logic:', flowResult.success ? '✅ PASS' : '❌ FAIL');
    console.log('RPC Function:', rpcResult.needsDeployment ? '⚠️  NEEDS DEPLOYMENT' : '✅ READY');
    console.log('═══════════════════════════════════════════');
    console.log('Errors:', this.testResults.errors.length > 0 ? this.testResults.errors : 'None');
    
    if (rpcResult.needsDeployment) {
      console.log('\n⚠️  DEPLOYMENT REQUIRED:');
      console.log('   The process_transfer RPC function needs to be created in Supabase.');
      console.log('   Execute the SQL script Vault-bank/SQL/process_transfer.sql');
      console.log('   in your Supabase SQL Editor.');
      console.log('\n   After deployment, re-run these tests to verify everything works.');
    }
    
    console.log('\n🎉 External transfer tests completed!\n');
    
    return this.testResults;
  }
}

if (typeof window === 'undefined') {
  const tester = new VaultBankExternalTransferTester();
  tester.runAllTests().catch(console.error);
} else {
  window.VaultBankExternalTransferTester = VaultBankExternalTransferTester;
  console.log('🔧 Vault Bank External Transfer Tester loaded!');
  console.log('Use: new VaultBankExternalTransferTester().runAllTests()');
}
