<#
.SYNOPSIS
    Haulotte PULSAR DTC Program Management - Internal Shared Web Server
.DESCRIPTION
    Lightweight, zero-dependency HTTP server utilizing .NET HttpListener.
    Serves the internal web application and provides persistent shared JSON storage.
    Run via: powershell -ExecutionPolicy Bypass -File server.ps1
#>

param(
    [int]$Port = 8080
)

$currentDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $currentDir) { $currentDir = Get-Location }

$dataFile = Join-Path $currentDir "pulsar_data.json"

Write-Host "===============================================================" -ForegroundColor Yellow
Write-Host "  HAULOTTE PULSAR DTC - INTERNAL SHARED COCKPIT SERVER         " -ForegroundColor DarkYellow
Write-Host "===============================================================" -ForegroundColor Yellow
Write-Host "  Root Directory : $currentDir" -ForegroundColor Cyan
Write-Host "  Port           : $Port" -ForegroundColor Cyan
Write-Host "  Shared Storage : $dataFile" -ForegroundColor Cyan
Write-Host "  Local URL      : http://localhost:$Port/" -ForegroundColor Green
Write-Host "===============================================================" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to terminate the server.`n" -ForegroundColor Gray

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Prefixes.Add("http://127.0.0.1:$Port/")

try {
    $listener.Start()
} catch {
    Write-Host "Failed to start listener on port $Port : $_" -ForegroundColor Red
    Write-Host "Tip: Run as Administrator or change port parameter, e.g. -Port 8085" -ForegroundColor Yellow
    exit 1
}

# Auto-open browser
Start-Process "http://localhost:$Port/"

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $urlPath = $request.Url.LocalPath
        if ($urlPath -eq "/" -or $urlPath -eq "") {
            $urlPath = "/index.html"
        }

        # CORS Headers for internal network
        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")

        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 200
            $response.Close()
            continue
        }

        # API: /api/status
        if ($urlPath -eq "/api/status") {
            $respJson = '{"status":"ok","shared":true,"storage":"file"}'
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($respJson)
            $response.ContentType = "application/json"
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.Close()
            continue
        }

        # API: /api/data (GET / POST)
        if ($urlPath -eq "/api/data") {
            if ($request.HttpMethod -eq "GET") {
                if (Test-Path $dataFile) {
                    $buffer = [System.IO.File]::ReadAllBytes($dataFile)
                } else {
                    $respJson = '{"empty":true}'
                    $buffer = [System.Text.Encoding]::UTF8.GetBytes($respJson)
                }
                $response.ContentType = "application/json"
                $response.ContentLength64 = $buffer.Length
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
                $response.Close()
                continue
            }
            elseif ($request.HttpMethod -eq "POST") {
                $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
                $postBody = $reader.ReadToEnd()
                $reader.Close()

                [System.IO.File]::WriteAllText($dataFile, $postBody, [System.Text.Encoding]::UTF8)

                $respJson = '{"status":"saved","timestamp":"' + (Get-Date).ToString("o") + '"}'
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($respJson)
                $response.ContentType = "application/json"
                $response.ContentLength64 = $buffer.Length
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
                $response.Close()
                continue
            }
        }

        # Static File Serving
        $localFilePath = Join-Path $currentDir ($urlPath.TrimStart('/').Replace('/', '\'))

        if (Test-Path $localFilePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($localFilePath).ToLower()
            $mime = "application/octet-stream"
            switch ($ext) {
                ".html" { $mime = "text/html; charset=utf-8" }
                ".css"  { $mime = "text/css; charset=utf-8" }
                ".js"   { $mime = "application/javascript; charset=utf-8" }
                ".json" { $mime = "application/json; charset=utf-8" }
                ".svg"  { $mime = "image/svg+xml" }
                ".png"  { $mime = "image/png" }
                ".jpg"  { $mime = "image/jpeg" }
            }

            $buffer = [System.IO.File]::ReadAllBytes($localFilePath)
            $response.ContentType = $mime
            $response.ContentLength64 = $buffer.Length
            $response.StatusCode = 200
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
        } else {
            $response.StatusCode = 404
            $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 - File Not Found")
            $response.OutputStream.Write($notFound, 0, $notFound.Length)
        }

        $response.Close()
    }
    catch {
        Write-Host "Request handling error: $_" -ForegroundColor DarkGray
    }
}
