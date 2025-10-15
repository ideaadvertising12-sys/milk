
"use client";

import React, { useState, useEffect, useMemo } from "react";
import { CalendarClock, FileText, DownloadCloud, ReceiptText, Banknote, Building, Newspaper, CreditCard, AlertTriangle, ArrowDown, ArrowUp, Beaker, Wallet, Landmark, Gift } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { useAuth } from "@/contexts/AuthContext";
import { AccessDenied } from "@/components/AccessDenied";
import { useRouter } from "next/navigation";
import { GlobalPreloaderScreen } from "@/components/GlobalPreloaderScreen";
import type { Sale, DayEndReportSummary, ReturnTransaction, StockTransaction, Expense } from "@/lib/types";
import { format, startOfDay, endOfDay, isSameDay } from "date-fns";
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { cn } from "@/lib/utils";
import { useSalesData } from "@/hooks/useSalesData"; 
import { useReturns } from "@/hooks/useReturns";
import { useStockTransactions } from "@/hooks/useStockTransactions";
import { useExpenses } from "@/hooks/useExpenses";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { useProducts } from "@/hooks/useProducts";

const formatCurrency = (amount: number | undefined): string => {
  if (amount === undefined || isNaN(amount)) return "Rs. 0.00";
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;
  return new Intl.NumberFormat('en-LK', { 
    style: 'currency', 
    currency: 'LKR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2 
  }).format(rounded).replace("LKR", "Rs.");
};

export default function DayEndReportPage() {
  const { currentUser } = useAuth();
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [reportSummary, setReportSummary] = useState<DayEndReportSummary | null>(null);

  const { sales: allSales, isLoading: isLoadingSales, error: salesError } = useSalesData(true); 
  const { returns, isLoading: isLoadingReturns, error: returnsError } = useReturns();
  const { transactions: allTransactions, isLoading: isLoadingTransactions, error: transactionsError } = useStockTransactions();
  const { expenses, isLoading: isLoadingExpenses, error: expensesError } = useExpenses();
  const { products: allProducts, isLoading: isLoadingProducts, error: productsError } = useProducts();


  useEffect(() => {
    if (selectedDate && !isLoadingSales && allSales && !isLoadingReturns && returns && !isLoadingTransactions && allTransactions && !isLoadingExpenses && expenses && !isLoadingProducts && allProducts) {
      
      const activeSales = allSales.filter(s => s.status !== 'cancelled');
      const salesToday = activeSales.filter(s => isSameDay(s.saleDate, selectedDate));
      const returnsToday = returns.filter(r => isSameDay(r.returnDate, selectedDate));
      const expensesTodayList = expenses.filter(e => isSameDay(e.expenseDate, selectedDate));
      const samplesIssuedToday = allTransactions.filter(tx => 
        tx.type === 'ISSUE_SAMPLE' && isSameDay(tx.transactionDate, selectedDate)
      );

      // --- Revenue Calculations ---
      const grossSalesToday = salesToday.reduce((sum, s) => {
        return sum + s.items.reduce((itemSum, item) => {
          return itemSum + (item.price * item.quantity);
        }, 0);
      }, 0);
      
      const totalSampleValue = samplesIssuedToday.reduce((sum, tx) => {
        const product = allProducts.find(p => p.id === tx.productId);
        const sampleValue = product ? tx.quantity * product.price : 0;
        return sum + sampleValue;
      }, 0);

      const totalDiscountsToday = salesToday.reduce((sum, sale) => {
          const saleDiscount = sale.items.reduce((itemSum, item) => {
              if (item.isOfferItem) return itemSum;
              const originalProduct = allProducts.find(p => p.id === item.id);
              const originalPrice = (item.saleType === 'wholesale' && originalProduct?.wholesalePrice) ? originalProduct.wholesalePrice : (originalProduct?.price || item.appliedPrice);
              const discountOnItem = originalPrice - item.appliedPrice;
              return itemSum + (discountOnItem * item.quantity);
          }, 0);
          return sum + saleDiscount;
      }, 0);
      
      const valueOfReturnedGoodsToday = returnsToday.reduce((sum, r) => {
        const hasNonResellable = r.returnedItems.some(item => !item.isResellable);
        if (hasNonResellable) {
            const exchangeValue = r.exchangedItems.reduce((itemSum, item) => itemSum + (item.appliedPrice * item.quantity), 0);
            return sum + exchangeValue;
        }
        return sum;
      }, 0);

      // --- Offer Items Calculations ---
      let totalFreeItemsCount = 0;
      let totalFreeItemsValue = 0;
      salesToday.forEach(sale => {
          sale.items.forEach(item => {
              if (item.isOfferItem) {
                  totalFreeItemsCount += item.quantity;
                  totalFreeItemsValue += item.quantity * item.price; // Cost is based on original price
              }
          });
      });
      
      const netSalesToday = grossSalesToday + totalSampleValue - (totalDiscountsToday + valueOfReturnedGoodsToday + totalFreeItemsValue + totalSampleValue);

      // --- Cash Flow Calculations ---
      const cashFromTodaySales = salesToday.reduce((sum, s) => sum + (s.paidAmountCash || 0), 0);
      
      let cashFromCreditPayments = 0;
      let chequeFromCreditPayments = 0;
      let bankFromCreditPayments = 0;
      let totalChequeIn = salesToday.reduce((sum, s) => sum + (s.paidAmountCheque || 0), 0);
      let totalBankTransferIn = salesToday.reduce((sum, s) => sum + (s.paidAmountBankTransfer || 0), 0);
      
      const collectedCheques: string[] = salesToday.flatMap(s => s.chequeDetails?.number ? [s.chequeDetails.number] : []);
      const collectedTransfers: string[] = salesToday.flatMap(s => s.bankTransferDetails?.referenceNumber ? [s.bankTransferDetails.referenceNumber] : []);
      
      activeSales.forEach(sale => {
          sale.additionalPayments?.forEach(p => {
            if (isSameDay(p.date, selectedDate)) {
              if (p.method === 'Cash') cashFromCreditPayments += p.amount;
              if (p.method === 'Cheque') {
                  chequeFromCreditPayments += p.amount;
                  if(p.details && 'number' in p.details && p.details.number) collectedCheques.push(p.details.number);
              }
              if (p.method === 'BankTransfer') {
                  bankFromCreditPayments += p.amount;
                  if(p.details && 'referenceNumber' in p.details && p.details.referenceNumber) collectedTransfers.push(p.details.referenceNumber);
              }
            }
          });
      });
      
      const totalCashIn = cashFromTodaySales + cashFromCreditPayments;
      totalChequeIn += chequeFromCreditPayments;
      totalBankTransferIn += bankFromCreditPayments;
      
      const totalCashPaidOutForRefunds = returnsToday.reduce((sum, r) => sum + (r.cashPaidOut || 0), 0);
      const totalExpensesToday = expensesTodayList.reduce((sum, e) => sum + e.amount, 0);
      const finalNetCashInHand = totalCashIn - totalCashPaidOutForRefunds - totalExpensesToday;

      // --- Credit Calculations ---
      const totalInitialCreditIssuedToday = salesToday.reduce((sum, s) => sum + (s.initialOutstandingBalance || 0), 0);
      const totalOutstandingFromToday = salesToday.reduce((sum, s) => sum + (s.outstandingBalance || 0), 0);
      const paidAgainstNewCredit = totalInitialCreditIssuedToday - totalOutstandingFromToday;
      const creditSalesCount = salesToday.filter(s => s.initialOutstandingBalance && s.initialOutstandingBalance > 0).length;
      const creditSettledByReturns = returnsToday.reduce((sum, r) => sum + (r.settleOutstandingAmount || 0), 0);

      // --- Sample Calculations ---
      const totalSamplesIssuedCount = samplesIssuedToday.reduce((sum, tx) => sum + tx.quantity, 0);
      const sampleTransactionsCount = samplesIssuedToday.length;
      
      setReportSummary({
        reportDate: selectedDate,
        totalTransactions: salesToday.length,
        grossSalesValue: grossSalesToday + totalSampleValue,
        totalDiscountsToday,
        valueOfReturnsToday: valueOfReturnedGoodsToday,
        netSalesValue: netSalesToday,
        
        cashFromSales: cashFromTodaySales,
        cashFromCreditPayments,
        chequeFromCreditPayments,
        bankFromCreditPayments,
        
        totalCashIn,
        totalChequeIn,
        totalBankTransferIn,
        
        totalRefundsPaidToday: totalCashPaidOutForRefunds,
        totalExpensesToday,
        netCashInHand: finalNetCashInHand,

        newCreditIssued: totalInitialCreditIssuedToday,
        creditSettledByReturns,
        paidAgainstNewCredit,
        netOutstandingFromToday: totalOutstandingFromToday,

        chequeNumbers: [...new Set(collectedCheques)],
        bankTransferRefs: [...new Set(collectedTransfers)],
        creditSalesCount,
        samplesIssuedCount: totalSamplesIssuedCount,
        sampleTransactionsCount,
        totalFreeItemsCount,
        totalFreeItemsValue,
      });

    } else {
      setReportSummary(null);
    }
  }, [selectedDate, allSales, isLoadingSales, returns, isLoadingReturns, allTransactions, isLoadingTransactions, expenses, isLoadingExpenses, allProducts, isLoadingProducts]);

  const handleExportPDF = () => {
    if (!reportSummary || !selectedDate) return;
    const doc = new jsPDF();
    const reportDateFormatted = format(selectedDate, "PPP");
    let yPos = 35;
    const sectionSpacing = 10;
    
    doc.setFontSize(18);
    doc.text("Day End Report", 105, 20, { align: "center" });
    doc.setFontSize(12);
    doc.text(`Date: ${reportDateFormatted}`, 105, 30, { align: "center" });

    const tableBody = [
        ['Gross Sales Today', formatCurrency(reportSummary.grossSalesValue)],
        ['Total Discounts Today', formatCurrency(reportSummary.totalDiscountsToday ?? 0)],
        ['Value of Returns Today', formatCurrency(reportSummary.valueOfReturnsToday)],
        [{ content: 'Net Sales Value', styles: { fontStyle: 'bold' } }, { content: formatCurrency(reportSummary.netSalesValue), styles: { fontStyle: 'bold' } }],
        [' ', ' '],
        ['Cash from Today\'s Sales', formatCurrency(reportSummary.cashFromSales)],
        ['Cash from Credit Payments', formatCurrency(reportSummary.cashFromCreditPayments)],
        [{ content: 'Total Cash In', styles: { fontStyle: 'bold' } }, { content: formatCurrency(reportSummary.totalCashIn), styles: { fontStyle: 'bold' } }],
        ['Less: Total Refunds Paid (Cash)', formatCurrency(reportSummary.totalRefundsPaidToday)],
        ['Less: Total Expenses', formatCurrency(reportSummary.totalExpensesToday)],
        [{ content: 'Final Net Cash In Hand', styles: { fontStyle: 'bold' } }, { content: formatCurrency(reportSummary.netCashInHand), styles: { fontStyle: 'bold' } }],
        [' ', ' '],
        ['Total Cheque In', formatCurrency(reportSummary.totalChequeIn)],
        ['Total Bank Transfer In', formatCurrency(reportSummary.totalBankTransferIn)],
        [' ', ' '],
        ['New Credit Issued Today', formatCurrency(reportSummary.newCreditIssued)],
        ["Paid Against Today's Credit", formatCurrency(reportSummary.paidAgainstNewCredit)],
        [{ content: 'Net Outstanding From Today', styles: { fontStyle: 'bold' } }, { content: formatCurrency(reportSummary.netOutstandingFromToday), styles: { fontStyle: 'bold' } }],
    ];

    autoTable(doc, {
        startY: yPos,
        head: [['Financial Summary', 'Amount']],
        body: tableBody,
        theme: 'striped',
        headStyles: { fillColor: [30, 18, 57] },
        columnStyles: { 1: { halign: 'right' } }
    });

    yPos = (doc as any).lastAutoTable.finalY + sectionSpacing;

    if (reportSummary.samplesIssuedCount > 0) {
        autoTable(doc, {
            startY: yPos,
            head: [['Samples Summary', 'Count']],
            body: [
                ['Total Sample Items Issued', reportSummary.samplesIssuedCount],
                ['Number of Sample Transactions', reportSummary.sampleTransactionsCount],
            ],
            theme: 'striped',
            headStyles: { fillColor: [30, 18, 57] },
            columnStyles: { 1: { halign: 'right' } }
        });
        yPos = (doc as any).lastAutoTable.finalY + sectionSpacing;
    }

    if (reportSummary.chequeNumbers.length > 0 || reportSummary.bankTransferRefs.length > 0) {
        doc.setFontSize(14);
        doc.text("Collection Details", 14, yPos);
        yPos += 7;
        doc.setFontSize(10);
        if (reportSummary.chequeNumbers.length > 0) {
            doc.text(`Collected Cheque Numbers: ${reportSummary.chequeNumbers.join(', ')}`, 14, yPos);
            yPos += 7;
        }
        if (reportSummary.bankTransferRefs.length > 0) {
            doc.text(`Collected Bank Transfer Refs: ${reportSummary.bankTransferRefs.join(', ')}`, 14, yPos);
        }
    }
    
    doc.save(`Day_End_Report_${format(selectedDate, "yyyy-MM-dd")}.pdf`);
  };

  const reportActions = (
    <div className="flex flex-col sm:flex-row gap-2 items-center">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant={"outline"}
            className={cn(
              "w-[220px] justify-start text-left font-normal h-10",
              !selectedDate && "text-muted-foreground"
            )}
          >
            <CalendarClock className="mr-2 h-4 w-4" />
            {selectedDate ? format(selectedDate, "PPP") : <span>Pick a date</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={setSelectedDate}
            initialFocus
            disabled={(date) => date > new Date() || date < new Date("2000-01-01")}
          />
        </PopoverContent>
      </Popover>
      <Button onClick={handleExportPDF} variant="outline" size="sm" disabled={!reportSummary || isLoadingSales || isLoadingReturns || isLoadingTransactions}>
        <DownloadCloud className="mr-2 h-4 w-4" /> Export PDF
      </Button>
    </div>
  );

  if (!currentUser) {
    return <GlobalPreloaderScreen message="Loading report..." />;
  }
  if (currentUser.role !== "admin") {
    return <AccessDenied message="Day End reports are not available for your role. Redirecting..." />;
  }
  
  const pageIsLoading = (isLoadingSales || isLoadingReturns || isLoadingTransactions || isLoadingExpenses || isLoadingProducts) && !reportSummary;

  if (pageIsLoading) {
    return <GlobalPreloaderScreen message="Fetching report data..." />
  }
  
  return (
    <>
      <PageHeader 
        title="Day End Report" 
        description="Summary of daily sales transactions and financial totals."
        icon={FileText}
        action={reportActions}
      />

      {(salesError || returnsError || transactionsError || expensesError || productsError) && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error Loading Data</AlertTitle>
          <AlertDescription>{salesError || returnsError || transactionsError || expensesError || productsError}</AlertDescription>
        </Alert>
      )}

      {reportSummary ? (
        <div className="space-y-6">
          <Card className="shadow-lg">
            <CardHeader>
              <CardTitle className="font-headline">Report for: {selectedDate ? format(selectedDate, "PPP") : "N/A"}</CardTitle>
              <CardDescription>
                <span className="font-medium">Total Sales Transactions: {reportSummary.totalTransactions}</span>
                {reportSummary.creditSalesCount > 0 && (
                  <span className="ml-4">Credit Sales: {reportSummary.creditSalesCount}</span>
                )}
              </CardDescription>
            </CardHeader>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2"><Banknote className="h-5 w-5"/>Cash Flow</CardTitle>
                <CardDescription>Detailed cash movements</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="flex justify-between"><span>Cash from Today's Sales:</span> <span className="font-semibold text-green-600">{formatCurrency(reportSummary.cashFromSales)}</span></p>
                <p className="flex justify-between"><span>Cash from Credit Payments:</span> <span className="font-semibold text-green-600">{formatCurrency(reportSummary.cashFromCreditPayments)}</span></p>
                <p className="flex justify-between font-bold"><span>Total Cash In:</span> <span>{formatCurrency(reportSummary.totalCashIn)}</span></p>
                <Separator className="my-2"/>
                <p className="flex justify-between"><span>Refunds Paid:</span> <span className="font-semibold text-destructive">{formatCurrency(reportSummary.totalRefundsPaidToday)}</span></p>
                <p className="flex justify-between"><span>Expenses Paid:</span> <span className="font-semibold text-destructive">{formatCurrency(reportSummary.totalExpensesToday)}</span></p>
                <Separator className="my-2"/>
                <p className="flex justify-between font-bold text-base text-primary"><span>Final Net Cash:</span> <span>{formatCurrency(reportSummary.netCashInHand)}</span></p>
              </CardContent>
            </Card>

             <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2"><Building className="h-5 w-5"/>Other Collections</CardTitle>
                <CardDescription>Cheques & Bank Transfers</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="flex justify-between"><span>Total Cheque In:</span> <span className="font-semibold">{formatCurrency(reportSummary.totalChequeIn)}</span></p>
                {reportSummary.chequeNumbers.length > 0 && <p className="text-xs text-muted-foreground">Cheque Nos: {reportSummary.chequeNumbers.join(', ')}</p>}
                <Separator className="my-2"/>
                <p className="flex justify-between"><span>Total Bank Transfer In:</span> <span className="font-semibold">{formatCurrency(reportSummary.totalBankTransferIn)}</span></p>
                {reportSummary.bankTransferRefs.length > 0 && <p className="text-xs text-muted-foreground">Ref Nos: {reportSummary.bankTransferRefs.join(', ')}</p>}
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2"><CreditCard className="h-5 w-5"/>Credit Summary</CardTitle>
                <CardDescription>New credit & payments</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                 <p className="flex justify-between">
                    <span>New Credit Issued Today:</span> 
                    <span className="font-semibold">{formatCurrency(reportSummary.newCreditIssued)}</span>
                </p>
                <Separator className="my-2"/>
                <h4 className="text-xs font-bold text-muted-foreground pt-1">CREDIT SETTLEMENTS TODAY</h4>
                 <p className="flex justify-between"><span>By Cash:</span> <span className="font-semibold">{formatCurrency(reportSummary.cashFromCreditPayments)}</span></p>
                 <p className="flex justify-between"><span>By Cheque:</span> <span className="font-semibold">{formatCurrency(reportSummary.chequeFromCreditPayments)}</span></p>
                 <p className="flex justify-between"><span>By Bank Transfer:</span> <span className="font-semibold">{formatCurrency(reportSummary.bankFromCreditPayments)}</span></p>
                 <p className="flex justify-between"><span>By Returns:</span> <span className="font-semibold">{formatCurrency(reportSummary.creditSettledByReturns)}</span></p>
                <Separator className="my-2"/>
                <p className="flex justify-between font-bold text-base"><span>Net Outstanding (from today's sales):</span> <span className="text-destructive">{formatCurrency(reportSummary.netOutstandingFromToday)}</span></p>
              </CardContent>
            </Card>
            
             <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2"><Beaker className="h-5 w-5 text-purple-600"/>Samples Issued</CardTitle>
                    <CardDescription>Free samples given out today</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                    <p className="flex justify-between"><span>Total Items Issued:</span> <span className="font-semibold">{reportSummary.samplesIssuedCount}</span></p>
                    <p className="flex justify-between"><span>Number of Transactions:</span> <span className="font-semibold">{reportSummary.sampleTransactionsCount}</span></p>
                </CardContent>
            </Card>
            
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2"><Gift className="h-5 w-5 text-green-600"/>Offer Free Items</CardTitle>
                    <CardDescription>Free items from "Buy 12 Get 1"</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                    <p className="flex justify-between"><span>Total Free Items:</span> <span className="font-semibold">{reportSummary.totalFreeItemsCount || 0}</span></p>
                    <p className="flex justify-between"><span>Cost of Free Items:</span> <span className="font-semibold">{formatCurrency(reportSummary.totalFreeItemsValue || 0)}</span></p>
                </CardContent>
            </Card>
          </div>

          <Card className="shadow-lg">
            <CardHeader>
              <CardTitle className="font-headline">Financial Overview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-md">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
                    <p className="flex justify-between"><span>Gross Sales Value:</span> <strong className="text-right">{formatCurrency(reportSummary.grossSalesValue)}</strong></p>
                    <p className="flex justify-between text-orange-500"><span>Discounts Given Today:</span> <strong className="text-right">{formatCurrency(reportSummary.totalDiscountsToday ?? 0)}</strong></p>
                    <p className="flex justify-between text-red-500"><span>Value of Returns Today:</span> <strong className="text-right">{formatCurrency(reportSummary.valueOfReturnsToday)}</strong></p>
                    <p className="flex justify-between text-blue-600"><span>Total Collections (Cash+Other):</span> <strong className="text-right">{formatCurrency(reportSummary.totalCashIn + reportSummary.totalChequeIn + reportSummary.totalBankTransferIn)}</strong></p>
                    <p className="flex justify-between text-destructive"><span>Total Refunds Paid Out (Cash):</span> <strong className="text-right">{formatCurrency(reportSummary.totalRefundsPaidToday)}</strong></p>
                    <p className="flex justify-between text-destructive"><span>Total Expenses Today:</span> <strong className="text-right">{formatCurrency(reportSummary.totalExpensesToday)}</strong></p>
                    <p className="flex justify-between font-bold text-primary text-lg border-t pt-2 mt-2"><span>Net Sales Value:</span> <strong className="text-right">{formatCurrency(reportSummary.netSalesValue)}</strong></p>
                    <p className="flex justify-between font-bold text-primary text-lg border-t pt-2 mt-2"><span>Net Cash In Hand:</span> <strong className="text-right">{formatCurrency(reportSummary.netCashInHand)}</strong></p>
                </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card className="shadow-lg">
          <CardHeader>
            <CardTitle className="font-headline">No Data</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground flex items-center">
              <ReceiptText className="mr-2 h-5 w-5" />
              {selectedDate ? `No transactions found for ${format(selectedDate, "PPP")}.` : "Please select a date to view the report."}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
