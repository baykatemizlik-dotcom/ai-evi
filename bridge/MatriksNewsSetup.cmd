@echo off
setlocal
if not exist "%LOCALAPPDATA%\AI_Evi" mkdir "%LOCALAPPDATA%\AI_Evi"
copy /Y "%~dp0bist_news_symbols.txt" "%LOCALAPPDATA%\AI_Evi\bist_news_symbols.txt" >nul
echo Symbols copied. Compile MatriksNewsEvents.cs as a separate MatriksIQ strategy.
echo Keep the existing price strategy running. This uploader sends no orders.
where py >nul 2>nul
if errorlevel 1 (
 python "%~dp0matriks_news_upload.py"
) else (
 py -3 "%~dp0matriks_news_upload.py"
)
pause
