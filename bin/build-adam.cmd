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
:: build-adam.cmd -- Adam builds itself, then adamtest, into this folder     ::
::                                                                           ::
:: First the build's inputs are copied into a snapshot                       ::
:: (projects\adam\output\snapshot: src\, projects\adam and                   ::
:: projects\adamtest without their output\, bin\res\libs and                 ::
:: bin\res\runtime), so the sources can be edited while it runs: every       ::
:: stage reads the snapshot alone (each stage runs from the snapshot's       ::
:: bin\, so its $P: res\ and its $R: paths are the snapshot's).              ::
::                                                                           ::
:: The adam.exe here builds the compiler (projects\adam) as stage A; A       ::
:: builds it again as stage B; B builds it as stage C. B and C must be       ::
:: byte-identical (the compiler reproduces itself, so a change to its        ::
:: code generation has settled), else nothing is installed. Then B builds    ::
:: adamtest (projects\adamtest), and B and that adamtest replace adam.exe    ::
:: and adamtest.exe here; the adam.exe they replace is kept as               ::
:: adam-prev.exe (the last good compiler, to fall back to). Stage files      ::
:: land in projects\*\output (ignored by git).                               ::
::                                                                           ::
:: Usage:   build-adam.cmd                                                   ::
:::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::

setlocal

cd /d "%~dp0"
set BIN=%~dp0
set OUT=%~dp0..\projects\adam\output
set SNAP=%OUT%\snapshot
set MAIN=..\projects\adam\src\adam.adam

echo [0/5] snapshot: the build's inputs copied
call :snap "%BIN%..\src" "%SNAP%\src"
if errorlevel 1 (echo BUILD FAILED - snapshot & exit /b 1)
call :snap "%BIN%..\projects\adam" "%SNAP%\projects\adam" /XD output
if errorlevel 1 (echo BUILD FAILED - snapshot & exit /b 1)
call :snap "%BIN%..\projects\adamtest" "%SNAP%\projects\adamtest" /XD output
if errorlevel 1 (echo BUILD FAILED - snapshot & exit /b 1)
call :snap "%BIN%res\libs" "%SNAP%\bin\res\libs"
if errorlevel 1 (echo BUILD FAILED - snapshot & exit /b 1)
call :snap "%BIN%res\runtime" "%SNAP%\bin\res\runtime"
if errorlevel 1 (echo BUILD FAILED - snapshot & exit /b 1)
copy /y "%BIN%adam.exe" "%SNAP%\bin\adam.exe" >nul
if errorlevel 1 (echo BUILD FAILED - snapshot & exit /b 1)

cd /d "%SNAP%\bin"

:: Every exe lands in <output>\bin (SU1); the installed adam.exe may predate that and
:: write stage A straight into its output folder, so the old copies go first and A is
:: taken from whichever place the build wrote
echo [1/5] stage A: adam.exe builds adam
del /q "%OUT%\stageA\adam.exe" "%OUT%\stageA\bin\adam.exe" 2>nul
adam.exe build %MAIN% -o "%OUT%\stageA"
if errorlevel 1 (echo BUILD FAILED - stage A & exit /b 1)
if exist "%OUT%\stageA\bin\adam.exe" (copy /y "%OUT%\stageA\bin\adam.exe" adam-stageA.exe >nul) else (copy /y "%OUT%\stageA\adam.exe" adam-stageA.exe >nul)

:: B and C are the compiler's own build (--adam-self-build: a release one, no leak tracker);
:: A is built plainly, since the installed adam.exe may predate the switch
echo [2/5] stage B: A builds adam
adam-stageA.exe build %MAIN% -o "%OUT%\stageB" --adam-self-build
if errorlevel 1 (echo BUILD FAILED - stage B & goto :failed)
copy /y "%OUT%\stageB\bin\adam.exe" adam-stageB.exe >nul

echo [3/5] stage C: B builds adam
adam-stageB.exe build %MAIN% -o "%OUT%\stageC" --adam-self-build
if errorlevel 1 (echo BUILD FAILED - stage C & goto :failed)

echo [4/5] B and C compared
fc /b "%OUT%\stageB\bin\adam.exe" "%OUT%\stageC\bin\adam.exe" >nul
if errorlevel 1 (echo BUILD FAILED - stage B and stage C differ & goto :failed)

echo [5/5] adamtest: B builds adamtest
adam-stageB.exe build ..\projects\adamtest\src\adamtest.adam -o "%BIN%..\projects\adamtest\output"
if errorlevel 1 (echo BUILD FAILED - adamtest & goto :failed)

copy /y "%BIN%adam.exe" "%BIN%adam-prev.exe" >nul
copy /y "%OUT%\stageB\bin\adam.exe" "%BIN%adam.exe" >nul
if errorlevel 1 (echo BUILD FAILED - adam.exe not installed & goto :failed)
copy /y "%BIN%..\projects\adamtest\output\bin\adamtest.exe" "%BIN%adamtest.exe" >nul
if errorlevel 1 (echo BUILD FAILED - adamtest.exe not installed & goto :failed)
del adam-stageA.exe adam-stageB.exe
echo BUILD OK
exit /b 0

:failed
del adam-stageA.exe adam-stageB.exe 2>nul
exit /b 1

:: Mirrors folder %1 into %2 (the snapshot is this script's own scratch);
:: %3 %4 pass robocopy an exclusion. robocopy's exit codes below 8 are success.
:snap
robocopy %1 %2 /MIR /NFL /NDL /NJH /NJS /NP %3 %4 >nul
if errorlevel 8 exit /b 1
exit /b 0
