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
  private void WriteRecord(object record)
  {
   try { lock(fileLock) { File.AppendAllText(Path.Combine(folder,"matriks_news_events.jsonl"),JsonConvert.SerializeObject(record)+"\n",new UTF8Encoding(false)); } }
   catch(Exception e) { Debug("News/event spool write failed: "+e.GetType().Name); }
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
   var symbols=File.ReadAllLines(Path.Combine(folder,"bist_news_symbols.txt")).Select(x=>x.Trim()).Where(x=>x.Length>0).Distinct().ToArray();
   var failures=new List<string>();int news=0,formation=0,detector=0;
   foreach(var symbol in symbols)
   {
    try { AddNewsSymbol(symbol);news++; } catch { failures.Add(symbol+":NEWS"); }
    try { AddFormationSymbol(symbol);formation++; } catch { failures.Add(symbol+":FORMATION"); }
    try { AddDetectorSymbol(symbol);detector++; } catch { failures.Add(symbol+":DETECTOR"); }
   }
   try { AddNewsKeyword("KAP"); } catch { failures.Add("KEYWORD:KAP"); }
   File.WriteAllText(Path.Combine(folder,"matriks_registration_status.json"),JsonConvert.SerializeObject(new { requested=symbols.Length,news,formation,detector,failures,trend_capture_verified=false }),new UTF8Encoding(false));
   Debug("Read-only collector registrations: news="+news+", formation="+formation+", detector="+detector+". SDK registration is not proof of licensed/full delivery.");
  }
  public override void OnNewsReceived(AlgoNewsModel model)
  {
   WriteRecord(new { kind="NEWS",source_record_id=model.NewsId.ToString(),headline=model.Header,published_at=Utc(model.DateTime),body="",related_symbols=model.Symbols,provider_sources=model.Source,has_detail=model.HasDetail,headline_only=true });
  }
  public override void OnFormationReceived(AlgoFormationModel model)
  {
   var time=model.InformTime.Year>=2000?model.InformTime:DateTime.UtcNow;
   WriteRecord(new { kind="FORMATION",source_record_id=model.SymbolName+":"+time.ToString("O")+":"+model.Name,symbol=model.SymbolName,headline=model.Description,published_at=Utc(time),event_data=model });
  }
  public override void OnDetectorReceived(AlgoDetectorModel model)
  {
   WriteRecord(new { kind="DETECTOR",source_record_id=model.SymbolName+":"+Utc(model.InformTime)+":"+model.Description,symbol=model.SymbolName,headline=model.Description,published_at=Utc(model.InformTime),event_data=model });
  }
 }
}
