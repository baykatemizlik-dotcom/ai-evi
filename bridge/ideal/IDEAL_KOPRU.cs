// iDeal ALGO formula body. No orders. .NET UDP sender; no undocumented UdpGonder signature.
// Installed universe: %LOCALAPPDATA%\AI_Evi\ideal_bridge\symbols.txt
// Vol = TL turnover. Size = share quantity (confirm field with your data package).
// Default price sweep once/sec, history two symbols/sec. No chart creation.
var dizin = System.IO.Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData), "AI_Evi", "ideal_bridge");
var listeDosya = System.IO.Path.Combine(dizin, "symbols.txt");
if (System.IO.File.Exists(listeDosya))
{
    var zaman = System.DateTime.UtcNow;
    var turDosya = System.IO.Path.Combine(dizin, "last_poll.txt");
    long onceki = 0;
    if (System.IO.File.Exists(turDosya)) long.TryParse(System.IO.File.ReadAllText(turDosya), out onceki);
    if (zaman.Ticks - onceki >= System.TimeSpan.TicksPerSecond)
    {
        System.IO.File.WriteAllText(turDosya, zaman.Ticks.ToString());
        var kodlar = System.IO.File.ReadAllText(listeDosya).Split(new char[] { ',', ';', '\r', '\n', ' ', '\t' }, System.StringSplitOptions.RemoveEmptyEntries);
        var kultur = System.Globalization.CultureInfo.InvariantCulture;
        var utc = zaman.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", kultur);
        using (var udp = new System.Net.Sockets.UdpClient())
        {
            udp.Connect("127.0.0.1", 5555);
            var metin = new System.Text.StringBuilder();
            int adet = 0;
            for (int i = 0; i < kodlar.Length; i++)
            {
                var kod = kodlar[i].Trim().ToUpperInvariant();
                var tam = "IMKBH'" + kod;
                try
                {
                    var v = Sistem.YuzeyselVeriOku(tam);
                    if (v.LastPrice <= 0 || v.LimitUp <= 0 || v.PrevCloseDay <= 0) continue;
                    metin.Append("Q;").Append(kod).Append(';').Append(v.LastPrice.ToString(kultur)).Append(';').Append(v.VolDay.ToString(kultur)).Append(';').Append(utc).Append(';').Append(Sistem.LotGun(tam).ToString(kultur)).Append(';').Append(v.LimitUp.ToString(kultur)).Append(';').Append(v.PrevCloseDay.ToString(kultur)).Append(';').Append(zaman.Ticks.ToString(kultur)).Append('\n');
                    adet++;
                    if (adet >= 50) { var b = System.Text.Encoding.UTF8.GetBytes(metin.ToString()); udp.Send(b, b.Length); metin.Clear(); adet = 0; }
                }
                catch (System.Exception ex) { Sistem.Debug("IDEAL_QUOTE " + kod + " " + ex.GetType().Name); }
            }
            if (metin.Length > 0) { var b = System.Text.Encoding.UTF8.GetBytes(metin.ToString()); udp.Send(b, b.Length); }
            // Round robin reads, 15m first, then 1m/60m/daily. No synthetic bars.
            // Reduce 2 to 1 if iDeal memory rises. Exported bars are capped per symbol.
            var cursorDosya = System.IO.Path.Combine(dizin, "history_cursor.txt");
            int cursor = 0;
            if (System.IO.File.Exists(cursorDosya)) int.TryParse(System.IO.File.ReadAllText(cursorDosya), out cursor);
            var periyotlar = new string[] { "15", "1", "60", "G" };
            var araliklar = new string[] { "15m", "1m", "60m", "1d" };
            var saniyeler = new int[] { 900, 60, 3600, 86400 };
            for (int islem = 0; islem < 2 && kodlar.Length > 0; islem++)
            {
                int j; int per;
                if (cursor % 4 != 3) { j = (cursor - cursor / 4) % kodlar.Length; per = 0; }
                else { int diger = cursor / 4; j = diger % kodlar.Length; per = 1 + (diger / kodlar.Length) % 3; }
                var kod = kodlar[j].Trim().ToUpperInvariant();
                try
                {
                    var barlar = Sistem.GrafikVerileriniOku("IMKBH'" + kod, periyotlar[per]);
                    int sinir = per == 0 ? 100 : per == 1 ? 180 : per == 2 ? 240 : 60;
                    metin.Clear(); adet = 0;
                    for (int k = System.Math.Max(0, barlar.Count - sinir); k < barlar.Count; k++)
                    {
                        var bar = barlar[k];
                        // iDeal chart Date is Istanbul session time. Convert explicitly to UTC.
                        var bas = System.DateTime.SpecifyKind(bar.Date, System.DateTimeKind.Unspecified).AddHours(-3);
                        var son = bas.AddSeconds(saniyeler[per]);
                        if (son > zaman || bar.Open <= 0 || bar.Close <= 0 || bar.Size < 0) continue;
                        metin.Append("B;").Append(kod).Append(';').Append(araliklar[per]).Append(';').Append(bas.ToString("yyyy-MM-ddTHH:mm:ssZ", kultur)).Append(';').Append(son.ToString("yyyy-MM-ddTHH:mm:ssZ", kultur)).Append(';').Append(bar.Open.ToString(kultur)).Append(';').Append(bar.High.ToString(kultur)).Append(';').Append(bar.Low.ToString(kultur)).Append(';').Append(bar.Close.ToString(kultur)).Append(';').Append(bar.Size.ToString(kultur)).Append(";LOT\n");
                        adet++;
                        if (adet >= 50) { var b = System.Text.Encoding.UTF8.GetBytes(metin.ToString()); udp.Send(b, b.Length); metin.Clear(); adet = 0; }
                    }
                    if (metin.Length > 0) { var b = System.Text.Encoding.UTF8.GetBytes(metin.ToString()); udp.Send(b, b.Length); }
                }
                catch (System.Exception ex) { Sistem.Debug("IDEAL_BAR " + kod + " " + ex.GetType().Name); }
                cursor = (cursor + 1) % (kodlar.Length * 12);
            }
            System.IO.File.WriteAllText(cursorDosya, cursor.ToString());
        }
    }
}
