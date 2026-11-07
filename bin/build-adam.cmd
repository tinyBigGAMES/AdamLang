@echo off

:::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
:: Adam(tm) Programming Language                                             ::
::                                                                           ::
:: Copyright (c) 2026-present tinyBigGAMES(tm) LLC                           ::
:: All Rights Reserved.                                                      ::
::                                                                           ::
:: https://adamlang.org                                                      ::
::                                                                           ::
:: SPDX-License-Identifier: MPL-2.0                                          ::
::                                                                           ::
:: This Source Code Form is subject to the terms of the                      ::
:: Mozilla Public License, v. 2.0. If a copy of the MPL                      ::
:: was not distributed with this file, You can obtain one                    ::
:: at https://mozilla.org/MPL/2.0/.                                          ::
::---------------------------------------------------------------------------::
:: build-adam.cmd -- Adam builds itself, then adamtest, into this folder      ::
::                                                                           ::
:: The adam.exe here builds the compiler's source (projects\adam) as stage  ::
:: A; A builds it again as stage B; B builds it as stage C. B and C must be  ::
:: byte-identical (the compiler reproduces itself, so a change to its code  ::
:: generation has settled), else nothing is installed. Then B builds        ::
:: adamtest (projects\adamtest), and B and that adamtest replace adam.exe   ::
:: and adamtest.exe here; the adam.exe they replace is kept as              ::
:: adam-prev.exe (the last good compiler, to fall back to). Each stage runs ::
:: from this folder (its $P: is where res\ is). Stage files land in         ::
:: projects\*\output (ignored by git).                                       ::
::                                                                           ::
:: Usage:   build-adam.cmd                                                   ::
:::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::

setlocal

cd /d "%~dp0"
set MAIN=..\projects\adam\src\adam.adam
set OUT=..\projects\adam\output

echo [1/5] stage A: adam.exe builds adam
adam.exe build %MAIN% -o %OUT%\stageA
if errorlevel 1 (echo BUILD FAILED - stage A & exit /b 1)
copy /y %OUT%\stageA\adam.exe adam-stageA.exe >nul

echo [2/5] stage B: A builds adam
adam-stageA.exe build %MAIN% -o %OUT%\stageB
if errorlevel 1 (echo BUILD FAILED - stage B & goto :failed)
copy /y %OUT%\stageB\adam.exe adam-stageB.exe >nul

echo [3/5] stage C: B builds adam
adam-stageB.exe build %MAIN% -o %OUT%\stageC
if errorlevel 1 (echo BUILD FAILED - stage C & goto :failed)

echo [4/5] B and C compared
fc /b %OUT%\stageB\adam.exe %OUT%\stageC\adam.exe >nul
if errorlevel 1 (echo BUILD FAILED - stage B and stage C differ & goto :failed)

echo [5/5] adamtest: B builds adamtest
adam-stageB.exe build ..\projects\adamtest\src\adamtest.adam -o ..\projects\adamtest\output
if errorlevel 1 (echo BUILD FAILED - adamtest & goto :failed)

copy /y adam.exe adam-prev.exe >nul
copy /y %OUT%\stageB\adam.exe adam.exe >nul
if errorlevel 1 (echo BUILD FAILED - adam.exe not installed & goto :failed)
copy /y ..\projects\adamtest\output\adamtest.exe adamtest.exe >nul
if errorlevel 1 (echo BUILD FAILED - adamtest.exe not installed & goto :failed)
del adam-stageA.exe adam-stageB.exe
echo BUILD OK
exit /b 0

:failed
del adam-stageA.exe adam-stageB.exe 2>nul
exit /b 1
