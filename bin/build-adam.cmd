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
:: One line over adam's own job, adam --dev-build-adam (Adam.Dev.BuildAdam,  ::
:: the same on every host; build-adam.sh is its linux twin): a snapshot of   ::
:: the inputs, stage A / B / C with B = C byte-identical, adamtest, the      ::
:: other host's pair cross-built (B = C too), the install (the adam.exe it   ::
:: replaces kept as adam-prev.exe) and the res\acu prebuild. It ends with    ::
:: BUILD OK, or BUILD FAILED - <step> and exit code 1.                       ::
::                                                                           ::
:: Usage:   build-adam.cmd                                                   ::
:::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::

"%~dp0adam.exe" --dev-build-adam
