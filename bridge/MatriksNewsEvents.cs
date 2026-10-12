// Separate read-only collector. Compile inside MatriksIQ AlgoTrader, not .NET CLI.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using Matriks.AlgoTrader;
using Matriks.Lean.Algotrader.AlgoBase;
using Matriks.Lean.Algotrader.Models;
using Matriks.Trader.Core;
using Matriks.Trader.Core.TraderModels;
using Newtonsoft.Json;

namespace Matriks.Lean.Algotrader
{
 public class MatriksNewsEvents : MatriksAlgo
 {
  private readonly object fileLock = new object();
  private string folder;
  private bool WriteRecord(object record)
  {
   try { lock(fileLock) { File.AppendAllText(Path.Combine(folder,"matriks_news_events.jsonl"),JsonConvert.SerializeObject(record)+"\n",new UTF8Encoding(false)); } return true; }
   catch(Exception e) { Debug("DOSYA YAZMA HATASI: "+e.GetType().Name+" | "+e.Message); return false; }
  }
  private string Utc(DateTime date)
  {
   // Matriks timestamps without timezone are treated as Turkish local time.
   var utc=date.Kind==DateTimeKind.Utc?date:new DateTimeOffset(DateTime.SpecifyKind(date,DateTimeKind.Unspecified),TimeSpan.FromHours(3)).UtcDateTime;
   return utc.ToString("yyyy-MM-ddTHH:mm:ssZ");
  }
  public override void OnInit()
  {
   folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AI_Evi");
   Directory.CreateDirectory(folder);
   // Create without truncating any existing records.
   using(var file=new FileStream(Path.Combine(folder,"matriks_news_events.jsonl"),FileMode.Append,FileAccess.Write,FileShare.Read)) { }
   var symbolPath=Path.Combine(folder,"bist_news_symbols.txt");
   var symbols=File.Exists(symbolPath)?File.ReadAllLines(symbolPath).Select(x=>x.Trim()).Where(x=>x.Length>0).Distinct().ToArray():new string[0];
   if(symbols.Length==0)Debug("SEMBOL DOSYASI YOK/BOS: "+symbolPath);
   var failures=new List<string>();int news=0,formation=0,detector=0;
   bool allNewsRequestAccepted=false;
   // Experimental: empty keyword behavior is NOT documented as full-feed support.
   try { AddNewsKeyword("",false,false);allNewsRequestAccepted=true;Debug("BOS KELIME DENEMESI KAYDEDILDI. Tum haber kapsamı henuz dogrulanmadi."); }
   catch(Exception e) { failures.Add("EMPTY_KEYWORD:"+e.GetType().Name);Debug("BOS KELIME REDDEDILDI: "+e.Message); }
   foreach(var symbol in symbols)
   {
    try { AddNewsSymbol(symbol);news++; } catch { failures.Add(symbol+":NEWS"); }
    try { AddFormationSymbol(symbol);formation++; } catch { failures.Add(symbol+":FORMATION"); }
    try { AddDetectorSymbol(symbol);detector++; } catch { failures.Add(symbol+":DETECTOR"); }
   }
   try { AddNewsKeyword("KAP"); } catch { failures.Add("KEYWORD:KAP"); }
   File.WriteAllText(Path.Combine(folder,"matriks_registration_status.json"),JsonConvert.SerializeObject(new { requested=symbols.Length,news,formation,detector,all_news_request_accepted=allNewsRequestAccepted,all_news_coverage_verified=false,failures,trend_capture_verified=false }),new UTF8Encoding(false));
   Debug("KAYIT DOSYASI: "+Path.Combine(folder,"matriks_news_events.jsonl"));
   Debug("Read-only collector registrations: news="+news+", formation="+formation+", detector="+detector+". SDK registration is not proof of licensed/full delivery.");
  }
  public override void OnNewsReceived(AlgoNewsModel model)
  {
   if(model==null)return;
   Debug("HABER CALLBACK: "+model.NewsId+" | "+model.Header);
   if(string.IsNullOrWhiteSpace(model.Header)||model.DateTime.Year<2000){Debug("BASLIK/TARIH EKSIK; haber kaydedilmedi.");return;}
   if(WriteRecord(new { kind="NEWS",source_record_id=model.NewsId.ToString(),headline=model.Header,published_at=Utc(model.DateTime),body="",related_symbols=model.Symbols,provider_sources=model.Source,has_detail=model.HasDetail,headline_only=true }))Debug("HABER DOSYAYA YAZILDI: "+model.NewsId);
  }
  public override void OnNewsReceived(int newsId,List<string> relatedSymbols)
  {
   // Diagnostic only: this older callback has no headline; do not invent one.
   Debug("ESKI HABER CALLBACK: "+newsId+" | Baslikli callback kontrol edilmeli.");
  }
  public override void OnFormationReceived(AlgoFormationModel model)
  {
   var time=model.InformTime.Year>=2000?model.InformTime:DateTime.UtcNow;
   if(WriteRecord(new { kind="FORMATION",source_record_id=model.SymbolName+":"+Utc(time)+":"+model.Name,symbol=model.SymbolName,headline=model.Description,published_at=Utc(time),event_data=model }))Debug("FORMASYON YAZILDI: "+model.SymbolName);
  }
  public override void OnDetectorReceived(AlgoDetectorModel model)
  {
   if(WriteRecord(new { kind="DETECTOR",source_record_id=model.SymbolName+":"+Utc(model.InformTime)+":"+model.Description,symbol=model.SymbolName,headline=model.Description,published_at=Utc(model.InformTime),event_data=model }))Debug("DEDEKTOR YAZILDI: "+model.SymbolName);
  }
 }
}
