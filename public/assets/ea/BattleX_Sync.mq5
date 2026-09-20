//+------------------------------------------------------------------+
//|                                                BattleX_Sync.mq5  |
//|                                  Copyright 2026, BattleX Journal |
//|                                       https://battlexjournal.com |
//+------------------------------------------------------------------+
#property copyright   "BattleX Journal"
#property link        "https://battlexjournal.com"
#property version     "1.00"
#property description "Auto-syncs closed trades from MetaTrader 5 directly into your BattleX Trading Journal."
#property description "Requires WebRequest enabled in MT5: Tools -> Options -> Expert Advisors"

//--- Inputs
input string   InpSyncToken       = "";                                    // BattleX Personal Sync Token (bx_live_...)
input string   InpServerUrl       = "https://battlexjournal.com/api/brokers/mt5/sync"; // BattleX Sync API Endpoint
input bool     InpSyncHistoryOnStart = true;                               // Sync today's closed trades on attach
input int      InpRetryTimeoutMs  = 5000;                                  // WebRequest Timeout (ms)

//--- Global Variables
datetime g_lastCheckTime = 0;
ulong    g_syncedTickets[];

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   if(StringLen(InpSyncToken) == 0)
   {
      Print("⚠️ BattleX Sync: Please provide your BattleX Sync Token in EA inputs!");
      return(INIT_PARAMETERS_INCORRECT);
   }

   Print("✅ BattleX Sync EA Initialized. Target: ", InpServerUrl);
   g_lastCheckTime = TimeCurrent();

   // Sync history on start if enabled
   if(InpSyncHistoryOnStart)
   {
      SyncRecentHistory();
   }

   EventSetTimer(3); // Check every 3 seconds
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("🛑 BattleX Sync EA Stopped.");
}

//+------------------------------------------------------------------+
//| Check if ticket was already synced this session                  |
//+------------------------------------------------------------------+
bool IsTicketAlreadySynced(ulong ticket)
{
   int size = ArraySize(g_syncedTickets);
   for(int i = 0; i < size; i++)
   {
      if(g_syncedTickets[i] == ticket)
         return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Mark ticket as synced                                            |
//+------------------------------------------------------------------+
void MarkTicketSynced(ulong ticket)
{
   int size = ArraySize(g_syncedTickets);
   ArrayResize(g_syncedTickets, size + 1);
   g_syncedTickets[size] = ticket;
}

//+------------------------------------------------------------------+
//| Build JSON string safely                                         |
//+------------------------------------------------------------------+
string FormatTradeJson(ulong dealTicket, string symbol, int dealType, double volume,
                       double openPrice, double closePrice, datetime openTime, datetime closeTime,
                       double sl, double tp, double pnl, double commission, double swap,
                       long magic, string comment)
{
   string typeStr = (dealType == DEAL_TYPE_BUY) ? "BUY" : "SELL";
   string json = "{";
   json += "\"ticket\":" + IntegerToString(dealTicket) + ",";
   json += "\"symbol\":\"" + symbol + "\",";
   json += "\"type\":\"" + typeStr + "\",";
   json += "\"lots\":" + DoubleToString(volume, 2) + ",";
   json += "\"openPrice\":" + DoubleToString(openPrice, 5) + ",";
   json += "\"closePrice\":" + DoubleToString(closePrice, 5) + ",";
   json += "\"openTime\":\"" + TimeToString(openTime, TIME_DATE|TIME_SECONDS) + "\",";
   json += "\"closeTime\":\"" + TimeToString(closeTime, TIME_DATE|TIME_SECONDS) + "\",";
   json += "\"sl\":" + DoubleToString(sl, 5) + ",";
   json += "\"tp\":" + DoubleToString(tp, 5) + ",";
   json += "\"pnl\":" + DoubleToString(pnl, 2) + ",";
   json += "\"commission\":" + DoubleToString(commission, 2) + ",";
   json += "\"swap\":" + DoubleToString(swap, 2) + ",";
   json += "\"magic\":" + IntegerToString(magic) + ",";
   json += "\"comment\":\"" + comment + "\"";
   json += "}";
   return json;
}

//+------------------------------------------------------------------+
//| Send Trade WebRequest to BattleX                                 |
//+------------------------------------------------------------------+
bool SendTradeToBattleX(string jsonPayload, ulong dealTicket)
{
   char postData[];
   char resultData[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n" +
                    "X-BattleX-Token: " + InpSyncToken + "\r\n";

   StringToCharArray(jsonPayload, postData, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(postData, ArraySize(postData) - 1); // remove null terminator

   ResetLastError();
   int res = WebRequest("POST", InpServerUrl, headers, InpRetryTimeoutMs, postData, resultData, resultHeaders);

   if(res == -1)
   {
      int err = GetLastError();
      Print("❌ BattleX WebRequest failed. Error code: ", err);
      if(err == 4014)
      {
         Print("⚠️ ERROR 4014: Please add '", InpServerUrl, "' to the allowed WebRequest URL list in MT5 Options -> Expert Advisors!");
      }
      return false;
   }

   string responseStr = CharArrayToString(resultData, 0, WHOLE_ARRAY, CP_UTF8);
   if(res >= 200 && res < 300)
   {
      Print("⚡ BattleX Sync Success! Ticket #", dealTicket, " logged to Journal. Server code: ", res);
      MarkTicketSynced(dealTicket);
      return true;
   }
   else
   {
      Print("⚠️ BattleX Server returned code ", res, ": ", responseStr);
      return false;
   }
}

//+------------------------------------------------------------------+
//| Sync recent history deals                                        |
//+------------------------------------------------------------------+
void SyncRecentHistory()
{
   datetime fromTime = TimeCurrent() - 86400; // Last 24 hours
   datetime toTime   = TimeCurrent() + 60;

   if(!HistorySelect(fromTime, toTime)) return;

   int totalDeals = HistoryDealsTotal();
   for(int i = 0; i < totalDeals; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;

      long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT) continue; // Only process closing deals

      if(IsTicketAlreadySynced(ticket)) continue;

      string symbol = HistoryDealGetString(ticket, DEAL_SYMBOL);
      long dealType = HistoryDealGetInteger(ticket, DEAL_TYPE);
      double vol    = HistoryDealGetDouble(ticket, DEAL_VOLUME);
      double price  = HistoryDealGetDouble(ticket, DEAL_PRICE);
      double profit = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      double comm   = HistoryDealGetDouble(ticket, DEAL_COMMISSION);
      double swap   = HistoryDealGetDouble(ticket, DEAL_SWAP);
      datetime closeTime = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);
      long magic    = HistoryDealGetInteger(ticket, DEAL_MAGIC);
      string comment= HistoryDealGetString(ticket, DEAL_COMMENT);

      // Find original position open time and open price
      ulong positionId = HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      datetime openTime = closeTime;
      double openPrice  = price;

      if(HistorySelectByPosition(positionId))
      {
         int posDeals = HistoryDealsTotal();
         for(int j = 0; j < posDeals; j++)
         {
            ulong inTicket = HistoryDealGetTicket(j);
            if(HistoryDealGetInteger(inTicket, DEAL_ENTRY) == DEAL_ENTRY_IN)
            {
               openTime  = (datetime)HistoryDealGetInteger(inTicket, DEAL_TIME);
               openPrice = HistoryDealGetDouble(inTicket, DEAL_PRICE);
               break;
            }
         }
      }

      string payload = FormatTradeJson(ticket, symbol, (int)dealType, vol, openPrice, price,
                                       openTime, closeTime, 0, 0, profit, comm, swap, magic, comment);
      SendTradeToBattleX(payload, ticket);
   }
}

//+------------------------------------------------------------------+
//| Trade Transaction event handler                                  |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction& trans,
                        const MqlTradeRequest& request,
                        const MqlTradeResult& result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
   {
      ulong dealTicket = trans.deal;
      if(HistoryDealSelect(dealTicket))
      {
         long entry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
         if(entry == DEAL_ENTRY_OUT) // Trade closed
         {
            if(IsTicketAlreadySynced(dealTicket)) return;

            string symbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
            long dealType = HistoryDealGetInteger(dealTicket, DEAL_TYPE);
            double vol    = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);
            double closePrice = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
            double profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
            double comm   = HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
            double swap   = HistoryDealGetDouble(dealTicket, DEAL_SWAP);
            datetime closeTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
            long magic    = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
            string comment= HistoryDealGetString(dealTicket, DEAL_COMMENT);

            ulong positionId = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
            datetime openTime = closeTime;
            double openPrice = closePrice;

            if(HistorySelectByPosition(positionId))
            {
               int posDeals = HistoryDealsTotal();
               for(int j = 0; j < posDeals; j++)
               {
                  ulong inTicket = HistoryDealGetTicket(j);
                  if(HistoryDealGetInteger(inTicket, DEAL_ENTRY) == DEAL_ENTRY_IN)
                  {
                     openTime  = (datetime)HistoryDealGetInteger(inTicket, DEAL_TIME);
                     openPrice = HistoryDealGetDouble(inTicket, DEAL_PRICE);
                     break;
                  }
               }
            }

            string payload = FormatTradeJson(dealTicket, symbol, (int)dealType, vol, openPrice, closePrice,
                                             openTime, closeTime, 0, 0, profit, comm, swap, magic, comment);
            SendTradeToBattleX(payload, dealTicket);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Timer event to catch any missed historical trades                |
//+------------------------------------------------------------------+
void OnTimer()
{
   SyncRecentHistory();
}
//+------------------------------------------------------------------+
