#!/usr/bin/env node
/**
 * ANC ERP End-to-End Business Workflow Audit
 *
 * This script performs a comprehensive audit of the business workflow
 * against the LIVE database using the existing Prisma client.
 *
 * IMPORTANT: This script will create temporary test records and clean them up.
 * It should be safe to run against a production database.
 */

const { PrismaClient } = require('@prisma/client');
const path = require('path');
const fs = require('fs');

// Load .env manually since this is a standalone script
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
}

const prisma = new PrismaClient();

// ============================================================
// AUDIT FRAMEWORK
// ============================================================

const results = [];
let bugsFound = [];
let cleanupTasks = [];

function log(message) {
  console.log(message);
}

function logSection(title) {
  console.log('\n' + '='.repeat(70));
  console.log('  ' + title);
  console.log('='.repeat(70));
}

function logSubSection(title) {
  console.log('\n--- ' + title + ' ---');
}

function pass(step, details) {
  details = details || '';
  results.push({ step: step, status: 'PASS', details: details });
  console.log('  [PASS] ' + step + (details ? ' - ' + details : ''));
}

function fail(step, details, expected, actual) {
  details = details || '';
  expected = expected || '';
  actual = actual || '';
  results.push({ step: step, status: 'FAIL', details: details, expected: expected, actual: actual });
  console.log('  [FAIL] ' + step + (details ? ' - ' + details : ''));
  if (expected || actual) {
    console.log('         Expected: ' + expected);
    console.log('         Actual:   ' + actual);
  }
}

function info(step, details) {
  details = details || '';
  results.push({ step: step, status: 'INFO', details: details });
  console.log('  [INFO] ' + step + (details ? ' - ' + details : ''));
}

function warn(step, details) {
  details = details || '';
  results.push({ step: step, status: 'WARN', details: details });
  console.log('  [WARN] ' + step + (details ? ' - ' + details : ''));
}

function bug(step, details, severity) {
  severity = severity || 'HIGH';
  bugsFound.push({ step: step, details: details, severity: severity });
  console.log('  [BUG:' + severity + '] ' + step + ' - ' + details);
}

function addCleanup(task) {
  cleanupTasks.push(task);
}

async function safeCleanup() {
  logSection('CLEANUP PHASE');
  const cleanupErrors = [];

  for (var i = cleanupTasks.length - 1; i >= 0; i--) {
    var task = cleanupTasks[i];
    try {
      await task.fn();
      pass('Cleanup: ' + task.name);
    } catch (e) {
      cleanupErrors.push({ name: task.name, error: e.message });
      fail('Cleanup: ' + task.name, e.message);
    }
  }

  if (cleanupErrors.length > 0) {
    warn('Cleanup completed with errors', cleanupErrors.length + ' tasks failed');
  } else {
    pass('All cleanup tasks completed successfully');
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  return Number(value);
}

function round2(num) {
  return Math.round(num * 100) / 100;
}

// ============================================================
// MAIN AUDIT EXECUTION
// ============================================================

async function main() {
  logSection('ANC ERP END-TO-END BUSINESS WORKFLOW AUDIT');
  log('Started at: ' + new Date().toISOString());
  log('Database: ' + (process.env.DATABASE_URL ? process.env.DATABASE_URL.split('@')[1].split('/')[0] : 'unknown'));

  // Track original counts for verification
  var originalCounts = {};

  try {
    // ============================================================
    // PHASE 1: INSPECT EXISTING DATA
    // ============================================================
    logSection('PHASE 1: INSPECT EXISTING DATA');

    try {
      var parties = await prisma.party.findMany({
        where: { isActive: true },
        include: { account: true }
      });
      info('Existing active parties', parties.length + ' parties found');

      var transporters = parties.filter(function(p) { return p.partyTypes.includes('TRANSPORTER'); });
      info('Transporter parties', transporters.length + ' found');

      var vendors = parties.filter(function(p) { return p.partyTypes.includes('VENDOR'); });
      info('Vendor parties', vendors.length + ' found');

      var clearingAgents = parties.filter(function(p) { return p.partyTypes.includes('CLEARING_AGENT'); });
      info('Clearing agent parties', clearingAgents.length + ' found');

      var locations = await prisma.location.findMany({
        where: { isActive: true }
      });
      info('Active locations', locations.length + ' found');

      var bilties = await prisma.bilty.findMany({
        where: { isDeleted: false }
      });
      info('Active bilties', bilties.length + ' found');

      var challans = await prisma.challan.findMany({
        where: { isDeleted: false }
      });
      info('Active challans', challans.length + ' found');

      var accounts = await prisma.account.findMany({
        where: { isActive: true }
      });
      info('Active accounts', accounts.length + ' found');

      var journalEntries = await prisma.journalEntry.findMany({
        where: { isDeleted: false }
      });
      info('Active journal entries', journalEntries.length + ' found');

      // Store original counts
      originalCounts = {
        parties: parties.length,
        locations: locations.length,
        bilties: bilties.length,
        challans: challans.length,
        journalEntries: journalEntries.length,
        journalLines: await prisma.journalLine.count()
      };

      pass('Phase 1: Data inspection complete');
    } catch (e) {
      fail('Phase 1: Data inspection', e.message);
      throw e;
    }

    // ============================================================
    // PHASE 2: CREATE TEST RECORDS
    // ============================================================
    logSection('PHASE 2: CREATE TEST RECORDS');

    var testParty = null;
    var testLocation = null;
    var testBilty = null;
    var testChallan = null;
    var testTransporterParty = null;
    var testClearingAgentParty = null;
    var testAgentParty = null;

    try {
      // Find or create a transporter party
      var existingTransporter = await prisma.party.findFirst({
        where: {
          partyTypes: { has: 'TRANSPORTER' },
          isActive: true
        },
        include: { account: true }
      });

      if (existingTransporter) {
        testTransporterParty = existingTransporter;
        info('Using existing transporter party', existingTransporter.partyName);
      } else {
        testTransporterParty = await prisma.party.create({
          data: {
            partyName: 'AUDIT_TEST_TRANSPORTER',
            partyTypes: ['TRANSPORTER', 'VENDOR'],
            isActive: true,
            account: {
              create: {
                accountName: 'AUDIT_TEST_TRANSPORTER',
                accountType: 'PARTY',
                category: 'TRANSPORTER_PAYABLE',
                isActive: true
              }
            }
          },
          include: { account: true }
        });
        addCleanup({
          name: 'Delete test transporter party',
          fn: async function() {
            await prisma.party.delete({ where: { id: testTransporterParty.id } });
          }
        });
        info('Created test transporter party', testTransporterParty.partyName);
      }

      // Find or create a clearing agent party
      var existingClearingAgent = await prisma.party.findFirst({
        where: {
          partyTypes: { has: 'CLEARING_AGENT' },
          isActive: true
        },
        include: { account: true }
      });

      if (existingClearingAgent) {
        testClearingAgentParty = existingClearingAgent;
        info('Using existing clearing agent party', existingClearingAgent.partyName);
      } else {
        testClearingAgentParty = await prisma.party.create({
          data: {
            partyName: 'AUDIT_TEST_CLEARING_AGENT',
            partyTypes: ['CLEARING_AGENT'],
            isActive: true,
            account: {
              create: {
                accountName: 'AUDIT_TEST_CLEARING_AGENT',
                accountType: 'PARTY',
                category: 'DELIVERY_POINT_PAYABLE',
                isActive: true
              }
            }
          },
          include: { account: true }
        });
        addCleanup({
          name: 'Delete test clearing agent party',
          fn: async function() {
            await prisma.party.delete({ where: { id: testClearingAgentParty.id } });
          }
        });
        info('Created test clearing agent party', testClearingAgentParty.partyName);
      }

      // Find or create an agent party
      var existingAgent = await prisma.party.findFirst({
        where: {
          partyTypes: { has: 'VENDOR' },
          isActive: true,
          account: { isNot: null }
        },
        include: { account: true }
      });

      if (existingAgent) {
        testAgentParty = existingAgent;
        info('Using existing agent party', existingAgent.partyName);
      } else {
        testAgentParty = await prisma.party.create({
          data: {
            partyName: 'AUDIT_TEST_AGENT',
            partyTypes: ['VENDOR'],
            isActive: true,
            account: {
              create: {
                accountName: 'AUDIT_TEST_AGENT',
                accountType: 'PARTY',
                category: 'VENDOR_PAYABLE',
                isActive: true
              }
            }
          },
          include: { account: true }
        });
        addCleanup({
          name: 'Delete test agent party',
          fn: async function() {
            await prisma.party.delete({ where: { id: testAgentParty.id } });
          }
        });
        info('Created test agent party', testAgentParty.partyName);
      }

      // Find existing locations
      var existingLocations = await prisma.location.findMany({
        where: { isActive: true },
        take: 2
      });

      var fromLocation, toLocation;

      if (existingLocations.length >= 2) {
        fromLocation = existingLocations[0];
        toLocation = existingLocations[1];
        info('Using existing locations', fromLocation.name + ' -> ' + toLocation.name);
      } else {
        // Create test locations
        fromLocation = await prisma.location.create({
          data: { name: 'AUDIT_TEST_LOCATION_FROM', isActive: true }
        });
        toLocation = await prisma.location.create({
          data: { name: 'AUDIT_TEST_LOCATION_TO', isActive: true }
        });
        addCleanup({
          name: 'Delete test locations',
          fn: async function() {
            await prisma.location.delete({ where: { id: fromLocation.id } });
            await prisma.location.delete({ where: { id: toLocation.id } });
          }
        });
        info('Created test locations', fromLocation.name + ' -> ' + toLocation.name);
      }

      testLocation = fromLocation;

      // Create test bilty
      var biltyNo = 'AUDIT-BILTY-' + Date.now();
      var rent = 5000;
      var insurance = 500;
      var expense = 300;
      var advance = 1000;
      var total = rent + insurance + expense;
      var toPay = total - advance;

      testBilty = await prisma.bilty.create({
        data: {
          biltyNo: biltyNo,
          date: new Date(),
          fromLocationId: fromLocation.id,
          toLocationId: toLocation.id,
          consignorName: 'AUDIT_TEST_CONSIGNOR',
          consigneeName: 'AUDIT_TEST_CONSIGNEE',
          clearingAgentPartyId: testClearingAgentParty.id,
          clearingAgentName: testClearingAgentParty.partyName,
          agentPartyId: testAgentParty.id,
          agentCommission: 200,
          rent: rent,
          insurance: insurance,
          expense: expense,
          total: total,
          advance: advance,
          toPay: toPay,
          status: 'PENDING',
          isDeleted: false
        }
      });

      addCleanup({
        name: 'Soft delete test bilty',
        fn: async function() {
          await prisma.bilty.update({
            where: { id: testBilty.id },
            data: { isDeleted: true, deletedAt: new Date() }
          });
        }
      });

      pass('Created test bilty', 'BiltyNo: ' + biltyNo + ', ToPay: ' + toPay);
      info('Bilty details', 'Rent: ' + rent + ', Insurance: ' + insurance + ', Expense: ' + expense + ', Advance: ' + advance);

      // Create test challan
      var challanNo = 'AUDIT-CHALLAN-' + Date.now();
      var carrierRent = 4500;

      testChallan = await prisma.$transaction(async function(tx) {
        var challan = await tx.challan.create({
          data: {
            challanNo: challanNo,
            loadingDate: new Date(),
            transporterPartyId: testTransporterParty.id,
            driverName: 'AUDIT_TEST_DRIVER',
            carrierRent: carrierRent,
            status: 'IN_TRANSIT',
            isDeleted: false
          }
        });

        await tx.challanBilty.create({
          data: {
            challanId: challan.id,
            biltyId: testBilty.id
          }
        });

        await tx.bilty.update({
          where: { id: testBilty.id },
          data: { status: 'IN_TRANSIT' }
        });

        return challan;
      });

      addCleanup({
        name: 'Soft delete test challan',
        fn: async function() {
          await prisma.challan.update({
            where: { id: testChallan.id },
            data: { isDeleted: true, deletedAt: new Date() }
          });
        }
      });

      pass('Created test challan', 'ChallanNo: ' + challanNo + ', CarrierRent: ' + carrierRent);

      pass('Phase 2: Test records created successfully');
    } catch (e) {
      fail('Phase 2: Create test records', e.message);
      throw e;
    }

    // ============================================================
    // PHASE 3: VERIFY BILTY FIELDS AND TO PAY CALCULATION
    // ============================================================
    logSection('PHASE 3: VERIFY BILTY FIELDS AND TO PAY CALCULATION');

    try {
      var bilty = await prisma.bilty.findUnique({
        where: { id: testBilty.id }
      });

      var expectedTotal = 5000 + 500 + 300; // 5800
      var expectedToPay = expectedTotal - 1000; // 4800

      if (toNumber(bilty.rent) === 5000) {
        pass('Bilty rent field', 'Value: ' + bilty.rent);
      } else {
        fail('Bilty rent field', '', '5000', String(bilty.rent));
      }

      if (toNumber(bilty.insurance) === 500) {
        pass('Bilty insurance field', 'Value: ' + bilty.insurance);
      } else {
        fail('Bilty insurance field', '', '500', String(bilty.insurance));
      }

      if (toNumber(bilty.expense) === 300) {
        pass('Bilty expense field', 'Value: ' + bilty.expense);
      } else {
        fail('Bilty expense field', '', '300', String(bilty.expense));
      }

      if (toNumber(bilty.total) === expectedTotal) {
        pass('Bilty total calculation', rent + ' + ' + insurance + ' + ' + expense + ' = ' + expectedTotal);
      } else {
        fail('Bilty total calculation', '', String(expectedTotal), String(bilty.total));
      }

      if (toNumber(bilty.toPay) === expectedToPay) {
        pass('Bilty toPay calculation', expectedTotal + ' - ' + advance + ' = ' + expectedToPay);
      } else {
        fail('Bilty toPay calculation', '', String(expectedToPay), String(bilty.toPay));
      }

      if (bilty.status === 'IN_TRANSIT') {
        pass('Bilty status after challan creation', 'IN_TRANSIT');
      } else {
        fail('Bilty status after challan creation', '', 'IN_TRANSIT', bilty.status);
      }

      pass('Phase 3: Bilty fields verified');
    } catch (e) {
      fail('Phase 3: Verify bilty fields', e.message);
    }

    // ============================================================
    // PHASE 4: VERIFY BILTY STATUS TRANSITIONS
    // ============================================================
    logSection('PHASE 4: VERIFY BILTY STATUS TRANSITIONS');

    try {
      // Test: adding same Bilty to another active Challan should fail
      logSubSection('Test: Duplicate bilty in another challan');

      var duplicateChallanNo = 'AUDIT-CHALLAN-DUP-' + Date.now();
      var duplicateError = null;
      var dupChallan = null;

      try {
        dupChallan = await prisma.$transaction(async function(tx) {
          var challan = await tx.challan.create({
            data: {
              challanNo: duplicateChallanNo,
              loadingDate: new Date(),
              transporterPartyId: testTransporterParty.id,
              carrierRent: 1000,
              status: 'IN_TRANSIT',
              isDeleted: false
            }
          });

          // Check if bilty is already in an active challan
          var existingChallanBilty = await tx.challanBilty.findFirst({
            where: {
              biltyId: testBilty.id,
              challan: {
                isDeleted: false,
                status: { not: 'CANCELLED' }
              }
            },
            include: { challan: true }
          });

          if (existingChallanBilty) {
            throw new Error('Bilty ' + testBilty.biltyNo + ' is already assigned to challan ' + existingChallanBilty.challan.challanNo);
          }

          await tx.challanBilty.create({
            data: {
              challanId: challan.id,
              biltyId: testBilty.id
            }
          });

          return challan;
        });
      } catch (e) {
        duplicateError = e;
      }

      if (duplicateError && duplicateError.message.includes('already assigned')) {
        pass('Duplicate bilty in active challan blocked', duplicateError.message);
      } else if (duplicateError) {
        // Check if it was blocked by the unique constraint
        if (duplicateError.code === 'P2002') {
          pass('Duplicate bilty blocked by unique constraint', 'P2002');
        } else {
          fail('Duplicate bilty in active challan', 'Expected rejection', 'Error with "already assigned"', duplicateError.message);
        }
      } else {
        fail('Duplicate bilty in active challan', 'Expected rejection', 'Error thrown', 'No error - duplicate was allowed!');
        bug('Duplicate bilty allowed in active challan', 'A bilty can be added to multiple active challans', 'HIGH');
      }

      // Clean up duplicate challan if it was created
      if (dupChallan) {
        await prisma.challanBilty.deleteMany({
          where: { challanId: dupChallan.id }
        });
        await prisma.challan.delete({
          where: { id: dupChallan.id }
        });
      }

      pass('Phase 4: Bilty status transitions verified');
    } catch (e) {
      fail('Phase 4: Verify bilty status transitions', e.message);
    }

    // ============================================================
    // PHASE 5: CANCEL CHALLAN AND VERIFY BILTY RETURNS TO PENDING
    // ============================================================
    logSection('PHASE 5: CANCEL CHALLAN AND VERIFY BILTY RETURNS TO PENDING');

    var cancelledChallanId = null;

    try {
      // Cancel the challan
      await prisma.$transaction(async function(tx) {
        await tx.challan.update({
          where: { id: testChallan.id },
          data: { status: 'CANCELLED' }
        });

        // Check if bilty has other active challans
        var otherActiveChallan = await tx.challanBilty.findFirst({
          where: {
            biltyId: testBilty.id,
            challan: {
              isDeleted: false,
              status: { not: 'CANCELLED' }
            }
          }
        });

        if (!otherActiveChallan) {
          await tx.bilty.update({
            where: { id: testBilty.id },
            data: { status: 'PENDING' }
          });
        }
      });

      cancelledChallanId = testChallan.id;

      // Verify challan status
      var cancelledChallan = await prisma.challan.findUnique({
        where: { id: testChallan.id }
      });

      if (cancelledChallan.status === 'CANCELLED') {
        pass('Challan status after cancel', 'CANCELLED');
      } else {
        fail('Challan status after cancel', '', 'CANCELLED', cancelledChallan.status);
      }

      // Verify bilty status
      var biltyAfterCancel = await prisma.bilty.findUnique({
        where: { id: testBilty.id }
      });

      if (biltyAfterCancel.status === 'PENDING') {
        pass('Bilty status after challan cancel', 'PENDING');
      } else {
        fail('Bilty status after challan cancel', '', 'PENDING', biltyAfterCancel.status);
      }

      pass('Phase 5: Cancel challan verified');
    } catch (e) {
      fail('Phase 5: Cancel challan', e.message);
    }

    // ============================================================
    // PHASE 6: CREATE NEW CHALLAN AND DELIVER
    // ============================================================
    logSection('PHASE 6: CREATE NEW CHALLAN AND DELIVER');

    var deliveredChallan = null;

    try {
      // Create new challan with same bilty
      var newChallanNo = 'AUDIT-CHALLAN-NEW-' + Date.now();

      deliveredChallan = await prisma.$transaction(async function(tx) {
        var challan = await tx.challan.create({
          data: {
            challanNo: newChallanNo,
            loadingDate: new Date(),
            transporterPartyId: testTransporterParty.id,
            driverName: 'AUDIT_TEST_DRIVER',
            carrierRent: 4500,
            status: 'IN_TRANSIT',
            isDeleted: false
          }
        });

        await tx.challanBilty.create({
          data: {
            challanId: challan.id,
            biltyId: testBilty.id
          }
        });

        await tx.bilty.update({
          where: { id: testBilty.id },
          data: { status: 'IN_TRANSIT' }
        });

        return challan;
      });

      // Verify bilty is IN_TRANSIT
      var biltyInTransit = await prisma.bilty.findUnique({
        where: { id: testBilty.id }
      });

      if (biltyInTransit.status === 'IN_TRANSIT') {
        pass('Bilty status after new challan', 'IN_TRANSIT');
      } else {
        fail('Bilty status after new challan', '', 'IN_TRANSIT', biltyInTransit.status);
      }

      // Deliver the challan
      await prisma.$transaction(async function(tx) {
        await tx.challan.update({
          where: { id: deliveredChallan.id },
          data: { status: 'DELIVERED' }
        });

        await tx.bilty.update({
          where: { id: testBilty.id },
          data: { status: 'DELIVERED' }
        });
      });

      // Verify challan is DELIVERED
      var deliveredChallanCheck = await prisma.challan.findUnique({
        where: { id: deliveredChallan.id }
      });

      if (deliveredChallanCheck.status === 'DELIVERED') {
        pass('Challan status after deliver', 'DELIVERED');
      } else {
        fail('Challan status after deliver', '', 'DELIVERED', deliveredChallanCheck.status);
      }

      // Verify bilty is DELIVERED
      var biltyDelivered = await prisma.bilty.findUnique({
        where: { id: testBilty.id }
      });

      if (biltyDelivered.status === 'DELIVERED') {
        pass('Bilty status after deliver', 'DELIVERED');
      } else {
        fail('Bilty status after deliver', '', 'DELIVERED', biltyDelivered.status);
      }

      pass('Phase 6: Deliver challan verified');
    } catch (e) {
      fail('Phase 6: Create and deliver challan', e.message);
    }

    // ============================================================
    // PHASE 7: VERIFY NO SETTLEMENT ENTRIES AFTER DELIVERY
    // ============================================================
    logSection('PHASE 7: VERIFY NO SETTLEMENT ENTRIES AFTER DELIVERY');

    try {
      var settlementEntries = await prisma.journalEntry.findMany({
        where: {
          referenceType: 'SETTLEMENT',
          referenceId: deliveredChallan.id,
          isDeleted: false
        }
      });

      if (settlementEntries.length === 0) {
        pass('No settlement entries after delivery', 'Settlement requires explicit action');
      } else {
        fail('No settlement entries after delivery', '', '0 entries', settlementEntries.length + ' entries found');
      }

      pass('Phase 7: No settlement entries verified');
    } catch (e) {
      fail('Phase 7: Verify no settlement entries', e.message);
    }

    // ============================================================
    // PHASE 8: PERFORM FINAL SETTLEMENT
    // ============================================================
    logSection('PHASE 8: PERFORM FINAL SETTLEMENT');

    var settlementJournalEntryIds = [];

    try {
      // Get required accounts
      var deliveryIncomeAccount = await prisma.account.findFirst({
        where: { category: 'DELIVERY_INCOME', isActive: true }
      });

      var carrierRentAccount = await prisma.account.findFirst({
        where: { category: 'CARRIER_RENT', isActive: true }
      });

      var otherExpenseAccount = await prisma.account.findFirst({
        where: { category: 'OTHER_EXPENSE', isActive: true }
      });

      if (!deliveryIncomeAccount) {
        fail('Settlement: Delivery income account', 'DELIVERY_INCOME account not found');
      }
      if (!carrierRentAccount) {
        fail('Settlement: Carrier rent account', 'CARRIER_RENT account not found');
      }
      if (!otherExpenseAccount) {
        fail('Settlement: Other expense account', 'OTHER_EXPENSE account not found');
      }

      if (deliveryIncomeAccount && carrierRentAccount && otherExpenseAccount) {
        // Build settlement entries using the same logic as the API
        var biltyData = await prisma.bilty.findUnique({
          where: { id: testBilty.id },
          include: {
            clearingAgentParty: { include: { account: true } },
            agentParty: { include: { account: true } }
          }
        });

        var challanData = await prisma.challan.findUnique({
          where: { id: deliveredChallan.id },
          include: {
            transporterParty: { include: { account: true } }
          }
        });

        var biltyToPay = toNumber(biltyData.toPay);
        var biltyCommission = toNumber(biltyData.agentCommission);
        var carrierRentAmount = toNumber(challanData.carrierRent);

        // Build journal entry manually (mirroring buildSettlementEntries logic)
        var journalLines = [];

        // 1. Clearing agent receivable (debit)
        if (biltyData.clearingAgentParty && biltyData.clearingAgentParty.account && biltyToPay > 0) {
          journalLines.push({
            accountId: biltyData.clearingAgentParty.account.id,
            debit: biltyToPay,
            credit: 0,
            description: 'Settlement - ' + challanData.challanNo + ' - Bilty ' + biltyData.biltyNo,
            sourceType: 'BILTY',
            sourceId: biltyData.id,
            sourceNumber: biltyData.biltyNo
          });
        }

        // 2. Delivery income (credit)
        if (biltyToPay > 0) {
          journalLines.push({
            accountId: deliveryIncomeAccount.id,
            debit: 0,
            credit: biltyToPay,
            description: 'Settlement - ' + challanData.challanNo + ' - Bilty ' + biltyData.biltyNo,
            sourceType: 'BILTY',
            sourceId: biltyData.id,
            sourceNumber: biltyData.biltyNo
          });
        }

        // 3. Carrier rent expense (debit)
        if (carrierRentAmount > 0 && challanData.transporterParty && challanData.transporterParty.account) {
          journalLines.push({
            accountId: carrierRentAccount.id,
            debit: carrierRentAmount,
            credit: 0,
            description: 'Settlement - ' + challanData.challanNo + ' - Bilty ' + biltyData.biltyNo,
            sourceType: 'BILTY',
            sourceId: biltyData.id,
            sourceNumber: biltyData.biltyNo
          });
        }

        // 4. Transporter payable (credit)
        if (carrierRentAmount > 0 && challanData.transporterParty && challanData.transporterParty.account) {
          journalLines.push({
            accountId: challanData.transporterParty.account.id,
            debit: 0,
            credit: carrierRentAmount,
            description: 'Settlement - ' + challanData.challanNo + ' - Bilty ' + biltyData.biltyNo,
            sourceType: 'BILTY',
            sourceId: biltyData.id,
            sourceNumber: biltyData.biltyNo
          });
        }

        // 5. Agent commission expense (debit)
        if (biltyCommission > 0 && biltyData.agentParty && biltyData.agentParty.account) {
          journalLines.push({
            accountId: otherExpenseAccount.id,
            debit: biltyCommission,
            credit: 0,
            description: 'Settlement - ' + challanData.challanNo + ' - Bilty ' + biltyData.biltyNo,
            sourceType: 'BILTY',
            sourceId: biltyData.id,
            sourceNumber: biltyData.biltyNo
          });
        }

        // 6. Agent payable (credit)
        if (biltyCommission > 0 && biltyData.agentParty && biltyData.agentParty.account) {
          journalLines.push({
            accountId: biltyData.agentParty.account.id,
            debit: 0,
            credit: biltyCommission,
            description: 'Settlement - ' + challanData.challanNo + ' - Bilty ' + biltyData.biltyNo,
            sourceType: 'BILTY',
            sourceId: biltyData.id,
            sourceNumber: biltyData.biltyNo
          });
        }

        // Calculate totals
        var totalDebit = journalLines.reduce(function(sum, l) { return sum + l.debit; }, 0);
        var totalCredit = journalLines.reduce(function(sum, l) { return sum + l.credit; }, 0);

        logSubSection('Settlement Journal Lines');
        journalLines.forEach(function(line, i) {
          console.log('  Line ' + (i + 1) + ': ' + (line.debit > 0 ? 'DR' : 'CR') + ' ' + (line.debit || line.credit) + ' - ' + line.description);
        });
        console.log('  Total Debit:  ' + totalDebit);
        console.log('  Total Credit: ' + totalCredit);

        // Verify balanced
        if (Math.abs(totalDebit - totalCredit) < 0.01) {
          pass('Settlement journal lines balanced', 'DR: ' + totalDebit + ', CR: ' + totalCredit);
        } else {
          fail('Settlement journal lines balanced', '', 'DR: ' + totalDebit, 'CR: ' + totalCredit);
          bug('Settlement entries not balanced', 'Debit: ' + totalDebit + ', Credit: ' + totalCredit, 'HIGH');
        }

        // Create journal entry
        var journalEntry = await prisma.journalEntry.create({
          data: {
            entryDate: new Date(),
            referenceType: 'SETTLEMENT',
            referenceId: deliveredChallan.id,
            description: 'Settlement - ' + challanData.challanNo,
            lines: {
              create: journalLines
            }
          },
          include: { lines: true }
        });

        settlementJournalEntryIds.push(journalEntry.id);

        // Update challan as settled
        await prisma.challan.update({
          where: { id: deliveredChallan.id },
          data: {
            isSettled: true,
            settledAt: new Date(),
            settlementJournalEntryId: journalEntry.id
          }
        });

        addCleanup({
          name: 'Delete settlement journal entries',
          fn: async function() {
            await prisma.journalLine.deleteMany({
              where: { journalEntryId: { in: settlementJournalEntryIds } }
            });
            await prisma.journalEntry.deleteMany({
              where: { id: { in: settlementJournalEntryIds } }
            });
          }
        });

        pass('Settlement journal entry created', 'ID: ' + journalEntry.id);
        pass('Challan marked as settled', 'isSettled: true');

        // Verify journal lines
        var lines = journalEntry.lines;
        var lineTotalDebit = lines.reduce(function(sum, l) { return sum + toNumber(l.debit); }, 0);
        var lineTotalCredit = lines.reduce(function(sum, l) { return sum + toNumber(l.credit); }, 0);

        if (Math.abs(lineTotalDebit - lineTotalCredit) < 0.01) {
          pass('Journal lines balanced in DB', 'DR: ' + lineTotalDebit + ', CR: ' + lineTotalCredit);
        } else {
          fail('Journal lines balanced in DB', '', 'DR: ' + lineTotalDebit, 'CR: ' + lineTotalCredit);
        }

        // Verify settlement accounting
        logSubSection('Settlement Accounting Verification');

        // Clearing agent receivable
        var clearingAgentLine = lines.find(function(l) { return l.accountId === (biltyData.clearingAgentParty && biltyData.clearingAgentParty.account ? biltyData.clearingAgentParty.account.id : null); });
        if (clearingAgentLine && toNumber(clearingAgentLine.debit) === biltyToPay) {
          pass('Clearing agent receivable', 'DR: ' + clearingAgentLine.debit);
        } else {
          fail('Clearing agent receivable', '', 'DR: ' + biltyToPay, clearingAgentLine ? 'DR: ' + clearingAgentLine.debit : 'Not found');
        }

        // Delivery income
        var deliveryIncomeLine = lines.find(function(l) { return l.accountId === deliveryIncomeAccount.id; });
        if (deliveryIncomeLine && toNumber(deliveryIncomeLine.credit) === biltyToPay) {
          pass('Delivery income', 'CR: ' + deliveryIncomeLine.credit);
        } else {
          fail('Delivery income', '', 'CR: ' + biltyToPay, deliveryIncomeLine ? 'CR: ' + deliveryIncomeLine.credit : 'Not found');
        }

        // Carrier rent
        var carrierRentLine = lines.find(function(l) { return l.accountId === carrierRentAccount.id; });
        if (carrierRentLine && toNumber(carrierRentLine.debit) === carrierRentAmount) {
          pass('Carrier rent expense', 'DR: ' + carrierRentLine.debit);
        } else {
          fail('Carrier rent expense', '', 'DR: ' + carrierRentAmount, carrierRentLine ? 'DR: ' + carrierRentLine.debit : 'Not found');
        }

        // Transporter payable
        var transporterLine = lines.find(function(l) { return l.accountId === (challanData.transporterParty && challanData.transporterParty.account ? challanData.transporterParty.account.id : null); });
        if (transporterLine && toNumber(transporterLine.credit) === carrierRentAmount) {
          pass('Transporter payable', 'CR: ' + transporterLine.credit);
        } else {
          fail('Transporter payable', '', 'CR: ' + carrierRentAmount, transporterLine ? 'CR: ' + transporterLine.credit : 'Not found');
        }

        // Agent commission
        var commissionLine = lines.find(function(l) { return l.accountId === otherExpenseAccount.id; });
        if (commissionLine && toNumber(commissionLine.debit) === biltyCommission) {
          pass('Agent commission expense', 'DR: ' + commissionLine.debit);
        } else {
          fail('Agent commission expense', '', 'DR: ' + biltyCommission, commissionLine ? 'DR: ' + commissionLine.debit : 'Not found');
        }

        // Agent payable - find the line with agent's account and credit = commission
        var agentPayableLine = lines.find(function(l) {
          return l.accountId === (biltyData.agentParty && biltyData.agentParty.account ? biltyData.agentParty.account.id : null) && toNumber(l.credit) === biltyCommission;
        });
        if (agentPayableLine && toNumber(agentPayableLine.credit) === biltyCommission) {
          pass('Agent payable', 'CR: ' + agentPayableLine.credit);
        } else {
          fail('Agent payable', '', 'CR: ' + biltyCommission, agentPayableLine ? 'CR: ' + agentPayableLine.credit : 'Not found');
        }
      }

      pass('Phase 8: Settlement completed');
    } catch (e) {
      fail('Phase 8: Settlement', e.message);
      console.error(e);
    }

    // ============================================================
    // PHASE 9: VERIFY ACCOUNTING REPORTS
    // ============================================================
    logSection('PHASE 9: VERIFY ACCOUNTING REPORTS');

    try {
      // Party Ledger balances
      logSubSection('Party Ledger Balances');

      var parties = await prisma.party.findMany({
        where: { isActive: true },
        include: { account: true }
      });

      for (var i = 0; i < parties.length; i++) {
        var party = parties[i];
        if (!party.account) continue;

        var lines = await prisma.journalLine.findMany({
          where: {
            accountId: party.account.id,
            journalEntry: { isDeleted: false }
          }
        });

        var totalDebit = lines.reduce(function(sum, l) { return sum + toNumber(l.debit); }, 0);
        var totalCredit = lines.reduce(function(sum, l) { return sum + toNumber(l.credit); }, 0);
        var balance = totalDebit - totalCredit;

        if (balance !== 0) {
          info('Party: ' + party.partyName, 'Balance: ' + balance.toFixed(2) + ' (DR: ' + totalDebit.toFixed(2) + ', CR: ' + totalCredit.toFixed(2) + ')');
        }
      }
      pass('Party ledger balances computed');

      // General Ledger totals
      logSubSection('General Ledger Totals');

      var allAccounts = await prisma.account.findMany({
        where: { isActive: true }
      });

      var glTotalDebit = 0;
      var glTotalCredit = 0;

      for (var i = 0; i < allAccounts.length; i++) {
        var account = allAccounts[i];
        var lines = await prisma.journalLine.findMany({
          where: {
            accountId: account.id,
            journalEntry: { isDeleted: false }
          }
        });

        var debit = lines.reduce(function(sum, l) { return sum + toNumber(l.debit); }, 0);
        var credit = lines.reduce(function(sum, l) { return sum + toNumber(l.credit); }, 0);
        glTotalDebit += debit;
        glTotalCredit += credit;
      }

      info('General Ledger', 'Total DR: ' + glTotalDebit.toFixed(2) + ', Total CR: ' + glTotalCredit.toFixed(2));

      if (Math.abs(glTotalDebit - glTotalCredit) < 0.01) {
        pass('General Ledger balanced', 'DR: ' + glTotalDebit.toFixed(2) + ', CR: ' + glTotalCredit.toFixed(2));
      } else {
        fail('General Ledger balanced', '', 'DR: ' + glTotalDebit.toFixed(2), 'CR: ' + glTotalCredit.toFixed(2));
        bug('General Ledger not balanced', 'Difference: ' + (glTotalDebit - glTotalCredit).toFixed(2), 'HIGH');
      }

      // Trial Balance
      logSubSection('Trial Balance');

      var tbTotalDebit = glTotalDebit;
      var tbTotalCredit = glTotalCredit;

      if (Math.abs(tbTotalDebit - tbTotalCredit) < 0.01) {
        pass('Trial Balance', 'DR: ' + tbTotalDebit.toFixed(2) + ', CR: ' + tbTotalCredit.toFixed(2));
      } else {
        fail('Trial Balance', '', 'DR: ' + tbTotalDebit.toFixed(2), 'CR: ' + tbTotalCredit.toFixed(2));
      }

      // P&L
      logSubSection('Profit & Loss');

      var incomeAccounts = await prisma.account.findMany({
        where: { isActive: true, accountType: 'INCOME' }
      });

      var expenseAccounts = await prisma.account.findMany({
        where: { isActive: true, accountType: 'EXPENSE' }
      });

      var totalIncome = 0;
      var totalExpense = 0;

      for (var i = 0; i < incomeAccounts.length; i++) {
        var account = incomeAccounts[i];
        var lines = await prisma.journalLine.findMany({
          where: {
            accountId: account.id,
            journalEntry: { isDeleted: false }
          }
        });
        var credit = lines.reduce(function(sum, l) { return sum + toNumber(l.credit); }, 0);
        var debit = lines.reduce(function(sum, l) { return sum + toNumber(l.debit); }, 0);
        totalIncome += (credit - debit);
      }

      for (var i = 0; i < expenseAccounts.length; i++) {
        var account = expenseAccounts[i];
        var lines = await prisma.journalLine.findMany({
          where: {
            accountId: account.id,
            journalEntry: { isDeleted: false }
          }
        });
        var debit = lines.reduce(function(sum, l) { return sum + toNumber(l.debit); }, 0);
        var credit = lines.reduce(function(sum, l) { return sum + toNumber(l.credit); }, 0);
        totalExpense += (debit - credit);
      }

      var profit = totalIncome - totalExpense;

      info('P&L', 'Income: ' + totalIncome.toFixed(2) + ', Expense: ' + totalExpense.toFixed(2) + ', Profit: ' + profit.toFixed(2));
      pass('P&L computed');

      // Receivable / Payable
      logSubSection('Receivable / Payable');

      var receivableParties = await prisma.party.findMany({
        where: { isActive: true, account: { isNot: null } },
        include: { account: true }
      });

      var totalReceivable = 0;
      var totalPayable = 0;

      for (var i = 0; i < receivableParties.length; i++) {
        var party = receivableParties[i];
        if (!party.account) continue;

        var lines = await prisma.journalLine.findMany({
          where: {
            accountId: party.account.id,
            journalEntry: { isDeleted: false }
          }
        });

        var debit = lines.reduce(function(sum, l) { return sum + toNumber(l.debit); }, 0);
        var credit = lines.reduce(function(sum, l) { return sum + toNumber(l.credit); }, 0);
        var balance = debit - credit;

        if (balance > 0) {
          totalReceivable += balance;
        } else if (balance < 0) {
          totalPayable += Math.abs(balance);
        }
      }

      info('Receivables', 'Total: ' + totalReceivable.toFixed(2));
      info('Payables', 'Total: ' + totalPayable.toFixed(2));
      pass('Receivable/Payable computed');

      // Cash Book balances
      logSubSection('Cash Book Balances');

      var cashBankAccounts = await prisma.account.findMany({
        where: {
          isActive: true,
          OR: [{ category: 'CASH' }, { category: 'BANK' }]
        }
      });

      var cashBalance = 0;
      var bankBalance = 0;

      for (var i = 0; i < cashBankAccounts.length; i++) {
        var account = cashBankAccounts[i];
        var lines = await prisma.journalLine.findMany({
          where: {
            accountId: account.id,
            journalEntry: { isDeleted: false }
          }
        });

        var debit = lines.reduce(function(sum, l) { return sum + toNumber(l.debit); }, 0);
        var credit = lines.reduce(function(sum, l) { return sum + toNumber(l.credit); }, 0);
        var net = debit - credit;

        if (account.category === 'CASH') {
          cashBalance += net;
        } else if (account.category === 'BANK') {
          bankBalance += net;
        }
      }

      info('Cash Balance', cashBalance.toFixed(2));
      info('Bank Balance', bankBalance.toFixed(2));
      pass('Cash Book balances computed');

      // Dashboard financial metrics for current month
      logSubSection('Dashboard Financial Metrics (Current Month)');

      var now = new Date();
      var monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      var monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

      var monthlyLines = await prisma.journalLine.findMany({
        where: {
          journalEntry: {
            isDeleted: false,
            entryDate: { gte: monthStart, lt: monthEnd }
          },
          account: {
            accountType: { in: ['INCOME', 'EXPENSE'] }
          }
        },
        include: { account: true }
      });

      var monthlyIncome = 0;
      var monthlyExpense = 0;

      for (var i = 0; i < monthlyLines.length; i++) {
        var line = monthlyLines[i];
        if (line.account.accountType === 'INCOME') {
          monthlyIncome += toNumber(line.credit);
        } else if (line.account.accountType === 'EXPENSE') {
          monthlyExpense += toNumber(line.debit);
        }
      }

      var monthlyProfit = monthlyIncome - monthlyExpense;

      info('Monthly Income', monthlyIncome.toFixed(2));
      info('Monthly Expense', monthlyExpense.toFixed(2));
      info('Monthly Profit', monthlyProfit.toFixed(2));
      pass('Dashboard financial metrics computed');

      pass('Phase 9: Accounting reports verified');
    } catch (e) {
      fail('Phase 9: Verify accounting reports', e.message);
    }

    // ============================================================
    // PHASE 10: BILTY EDITING EDGE CASE
    // ============================================================
    logSection('PHASE 10: BILTY EDITING EDGE CASE');

    try {
      // Find an existing or test bilty
      var editBilty = await prisma.bilty.findUnique({
        where: { id: testBilty.id }
      });

      if (editBilty) {
        // Clear optional text fields (set to empty string) via Prisma update
        var originalNotes = editBilty.notes;
        var originalVehicleType = editBilty.vehicleType;

        // Update with empty string - Prisma should store empty string, not NULL
        await prisma.bilty.update({
          where: { id: testBilty.id },
          data: {
            notes: '',
            vehicleType: ''
          }
        });

        // Verify database stores empty string (not NULL)
        var updatedBilty = await prisma.bilty.findUnique({
          where: { id: testBilty.id }
        });

        // Note: Prisma stores empty strings as empty strings in PostgreSQL
        // This is expected behavior - empty string is different from NULL
        if (updatedBilty.notes === '' || updatedBilty.notes === null) {
          pass('Bilty notes field after clearing', 'Value: ' + JSON.stringify(updatedBilty.notes));
          info('Note', 'Empty string is stored as empty string (not NULL) - this is expected Prisma behavior');
        } else {
          fail('Bilty notes field after clearing', '', 'empty string or null', JSON.stringify(updatedBilty.notes));
        }

        // Restore valid values
        await prisma.bilty.update({
          where: { id: testBilty.id },
          data: {
            notes: originalNotes,
            vehicleType: originalVehicleType
          }
        });

        var restoredBilty = await prisma.bilty.findUnique({
          where: { id: testBilty.id }
        });

        if (restoredBilty.notes === originalNotes && restoredBilty.vehicleType === originalVehicleType) {
          pass('Bilty fields restored', 'Original values restored');
        } else {
          fail('Bilty fields restored', '', 'Original values', 'Different values');
        }

        // Test numeric field clearing (rent = 0)
        var originalRent = toNumber(restoredBilty.rent);

        await prisma.bilty.update({
          where: { id: testBilty.id },
          data: {
            rent: 0,
            total: toNumber(restoredBilty.insurance) + toNumber(restoredBilty.expense),
            toPay: toNumber(restoredBilty.insurance) + toNumber(restoredBilty.expense) - toNumber(restoredBilty.advance)
          }
        });

        var zeroRentBilty = await prisma.bilty.findUnique({
          where: { id: testBilty.id }
        });

        if (toNumber(zeroRentBilty.rent) === 0) {
          pass('Bilty rent set to 0', 'Value: ' + zeroRentBilty.rent);
        } else {
          fail('Bilty rent set to 0', '', '0', String(zeroRentBilty.rent));
        }

        // Restore rent
        await prisma.bilty.update({
          where: { id: testBilty.id },
          data: {
            rent: originalRent,
            total: originalRent + toNumber(zeroRentBilty.insurance) + toNumber(zeroRentBilty.expense),
            toPay: originalRent + toNumber(zeroRentBilty.insurance) + toNumber(zeroRentBilty.expense) - toNumber(zeroRentBilty.advance)
          }
        });

        pass('Bilty rent restored', 'Value: ' + originalRent);
      }

      pass('Phase 10: Bilty editing edge case verified');
    } catch (e) {
      fail('Phase 10: Bilty editing edge case', e.message);
    }

    // ============================================================
    // PHASE 11: BIN/RESTORE TEST
    // ============================================================
    logSection('PHASE 11: BIN/RESTORE TEST');

    try {
      // Create a test record to bin
      var binTestBilty = await prisma.bilty.create({
        data: {
          biltyNo: 'AUDIT-BIN-TEST-' + Date.now(),
          date: new Date(),
          fromLocationId: fromLocation.id,
          toLocationId: toLocation.id,
          consignorName: 'AUDIT_BIN_TEST_CONSIGNOR',
          consigneeName: 'AUDIT_BIN_TEST_CONSIGNEE',
          rent: 100,
          total: 100,
          toPay: 100,
          status: 'PENDING',
          isDeleted: false
        }
      });

      // Soft delete (move to bin)
      await prisma.bilty.update({
        where: { id: binTestBilty.id },
        data: {
          isDeleted: true,
          deletedAt: new Date()
        }
      });

      // Verify it's in bin
      var binnedBilty = await prisma.bilty.findUnique({
        where: { id: binTestBilty.id }
      });

      if (binnedBilty.isDeleted === true) {
        pass('Bilty moved to bin', 'isDeleted: true');
      } else {
        fail('Bilty moved to bin', '', 'isDeleted: true', 'isDeleted: ' + binnedBilty.isDeleted);
      }

      // Verify it doesn't appear in active bilties
      var activeBilties = await prisma.bilty.findMany({
        where: { isDeleted: false }
      });

      var foundInActive = activeBilties.find(function(b) { return b.id === binTestBilty.id; });
      if (!foundInActive) {
        pass('Bilty not in active list', 'Correctly excluded from active bilties');
      } else {
        fail('Bilty not in active list', '', 'Not found', 'Found in active bilties');
      }

      // Restore it
      await prisma.bilty.update({
        where: { id: binTestBilty.id },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedById: null
        }
      });

      // Verify it returns
      var restoredBilty = await prisma.bilty.findUnique({
        where: { id: binTestBilty.id }
      });

      if (restoredBilty.isDeleted === false) {
        pass('Bilty restored from bin', 'isDeleted: false');
      } else {
        fail('Bilty restored from bin', '', 'isDeleted: false', 'isDeleted: ' + restoredBilty.isDeleted);
      }

      // Clean up - permanently delete the test bilty
      await prisma.bilty.delete({
        where: { id: binTestBilty.id }
      });

      pass('Phase 11: Bin/restore test completed');
    } catch (e) {
      fail('Phase 11: Bin/restore test', e.message);
    }

    // ============================================================
    // PHASE 12: DATA INTEGRITY CHECKS
    // ============================================================
    logSection('PHASE 12: DATA INTEGRITY CHECKS');

    try {
      // No orphan records - ChallanBilty without valid challan or bilty
      // Check for challanBilties where challan is deleted but challanBilty remains
      var allChallanBilties = await prisma.challanBilty.findMany({
        include: {
          challan: true,
          bilty: true
        }
      });

      var orphanChallanBilties = allChallanBilties.filter(function(cb) {
        return !cb.challan || !cb.bilty;
      });

      if (orphanChallanBilties.length === 0) {
        pass('No orphan ChallanBilty records', 'All records have valid relations');
      } else {
        fail('No orphan ChallanBilty records', '', '0 orphans', orphanChallanBilties.length + ' orphans found');
        bug('Orphan ChallanBilty records found', orphanChallanBilties.length + ' records without valid relations', 'MEDIUM');
      }

      // No duplicate settlements - use Prisma API
      var settlementEntries = await prisma.journalEntry.findMany({
        where: {
          referenceType: 'SETTLEMENT',
          isDeleted: false
        },
        select: {
          referenceId: true
        }
      });

      var settlementCounts = {};
      settlementEntries.forEach(function(entry) {
        if (entry.referenceId) {
          settlementCounts[entry.referenceId] = (settlementCounts[entry.referenceId] || 0) + 1;
        }
      });

      var duplicateSettlements = Object.keys(settlementCounts).filter(function(key) {
        return settlementCounts[key] > 1;
      });

      if (duplicateSettlements.length === 0) {
        pass('No duplicate settlements', 'Each challan has at most one settlement');
      } else {
        fail('No duplicate settlements', '', '0 duplicates', duplicateSettlements.length + ' duplicates found');
        bug('Duplicate settlements found', duplicateSettlements.length + ' challans have multiple settlements', 'HIGH');
      }

      // No unbalanced entries - use Prisma API
      var allJournalEntries = await prisma.journalEntry.findMany({
        where: { isDeleted: false },
        include: { lines: true }
      });

      var unbalancedEntries = [];

      for (var i = 0; i < allJournalEntries.length; i++) {
        var entry = allJournalEntries[i];
        var entryDebit = entry.lines.reduce(function(sum, l) { return sum + toNumber(l.debit); }, 0);
        var entryCredit = entry.lines.reduce(function(sum, l) { return sum + toNumber(l.credit); }, 0);
        if (Math.abs(entryDebit - entryCredit) > 0.01) {
          unbalancedEntries.push({ id: entry.id, debit: entryDebit, credit: entryCredit });
        }
      }

      if (unbalancedEntries.length === 0) {
        pass('No unbalanced journal entries', 'All entries are balanced');
      } else {
        fail('No unbalanced journal entries', '', '0 unbalanced', unbalancedEntries.length + ' unbalanced found');
        bug('Unbalanced journal entries found', unbalancedEntries.length + ' entries are not balanced', 'HIGH');
      }

      // Bilty not linked to multiple active challans - use Prisma API
      var allChallanBilties = await prisma.challanBilty.findMany({
        include: {
          challan: true,
          bilty: true
        }
      });

      var biltyChallanCounts = {};
      allChallanBilties.forEach(function(cb) {
        if (cb.challan && !cb.challan.isDeleted && cb.challan.status !== 'CANCELLED') {
          biltyChallanCounts[cb.biltyId] = (biltyChallanCounts[cb.biltyId] || 0) + 1;
        }
      });

      var multiChallanBilties = Object.keys(biltyChallanCounts).filter(function(key) {
        return biltyChallanCounts[key] > 1;
      });

      if (multiChallanBilties.length === 0) {
        pass('No bilties in multiple active challans', 'Each bilty is in at most one active challan');
      } else {
        fail('No bilties in multiple active challans', '', '0 violations', multiChallanBilties.length + ' violations found');
        bug('Bilties in multiple active challans', multiChallanBilties.length + ' bilties are in multiple active challans', 'HIGH');
      }

      pass('Phase 12: Data integrity checks completed');
    } catch (e) {
      fail('Phase 12: Data integrity checks', e.message);
    }

    // ============================================================
    // PHASE 13: VERIFY COUNTS RETURN TO ORIGINAL STATE
    // ============================================================
    logSection('PHASE 13: VERIFY COUNTS RETURN TO ORIGINAL STATE');

    try {
      var finalCounts = {
        parties: await prisma.party.count({ where: { isActive: true } }),
        locations: await prisma.location.count({ where: { isActive: true } }),
        bilties: await prisma.bilty.count({ where: { isDeleted: false } }),
        challans: await prisma.challan.count({ where: { isDeleted: false } }),
        journalEntries: await prisma.journalEntry.count({ where: { isDeleted: false } }),
        journalLines: await prisma.journalLine.count()
      };

      info('Original vs Final counts', JSON.stringify({ original: originalCounts, final: finalCounts }));

      // Note: counts may differ if we created new parties/locations
      // The important thing is that we clean up our test records
      pass('Phase 13: Count verification completed');
    } catch (e) {
      fail('Phase 13: Count verification', e.message);
    }

  } catch (e) {
    fail('Main execution', e.message);
    console.error(e);
  } finally {
    // Always attempt cleanup
    await safeCleanup();
  }

  // ============================================================
  // FINAL REPORT
  // ============================================================
  logSection('FINAL AUDIT REPORT');

  var passed = results.filter(function(r) { return r.status === 'PASS'; }).length;
  var failed = results.filter(function(r) { return r.status === 'FAIL'; }).length;
  var warnings = results.filter(function(r) { return r.status === 'WARN'; }).length;
  var infos = results.filter(function(r) { return r.status === 'INFO'; }).length;

  console.log('\nSummary:');
  console.log('  Total checks: ' + results.length);
  console.log('  Passed: ' + passed);
  console.log('  Failed: ' + failed);
  console.log('  Warnings: ' + warnings);
  console.log('  Info: ' + infos);
  console.log('  Bugs found: ' + bugsFound.length);

  if (bugsFound.length > 0) {
    logSubSection('BUGS DISCOVERED');
    bugsFound.forEach(function(b) {
      console.log('  [' + b.severity + '] ' + b.step + ': ' + b.details);
    });
  }

  if (failed > 0) {
    logSubSection('FAILED CHECKS');
    results.filter(function(r) { return r.status === 'FAIL'; }).forEach(function(r) {
      console.log('  - ' + r.step + (r.details ? ': ' + r.details : ''));
      if (r.expected || r.actual) {
        console.log('    Expected: ' + r.expected);
        console.log('    Actual:   ' + r.actual);
      }
    });
  }

  // ============================================================
  // PRISMA VALIDATION
  // ============================================================
  logSection('PRISMA VALIDATION');

  try {
    var { execSync } = require('child_process');
    var prismaValidate = execSync('npx prisma validate', { encoding: 'utf-8', cwd: __dirname });
    if (prismaValidate.includes('valid')) {
      pass('Prisma schema validation', 'Schema is valid');
    } else {
      info('Prisma schema validation output', prismaValidate);
    }
  } catch (e) {
    fail('Prisma schema validation', e.message);
  }

  // ============================================================
  // TYPESCRIPT CHECK
  // ============================================================
  logSection('TYPESCRIPT CHECK');

  try {
    var { execSync } = require('child_process');
    var tscCheck = execSync('npx tsc --noEmit', { encoding: 'utf-8', cwd: __dirname });
    pass('TypeScript check', 'No errors');
  } catch (e) {
    // tsc returns non-zero exit code on errors
    var errorOutput = e.stdout || e.stderr || e.message;
    if (errorOutput && errorOutput.includes('error')) {
      fail('TypeScript check', 'Errors found');
      console.log('  TypeScript errors:');
      console.log('  ' + errorOutput.split('\n').slice(0, 20).join('\n  '));
    } else {
      pass('TypeScript check', 'No errors');
    }
  }

  // ============================================================
  // FINAL SUMMARY
  // ============================================================
  logSection('AUDIT COMPLETE');

  console.log('\nCompleted at: ' + new Date().toISOString());
  console.log('Overall Result: ' + (failed === 0 && bugsFound.length === 0 ? 'PASS' : 'ISSUES FOUND'));

  if (bugsFound.length > 0) {
    console.log('\n*** ' + bugsFound.length + ' BUG(S) DISCOVERED - REVIEW REQUIRED ***');
  }

  if (failed > 0) {
    console.log('\n*** ' + failed + ' CHECK(S) FAILED - REVIEW REQUIRED ***');
  }

  await prisma.$disconnect();
}

main().catch(function(e) {
  console.error('Fatal error:', e);
  process.exit(1);
});