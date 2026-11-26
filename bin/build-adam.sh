#!/bin/sh
#############################################################################
# Adam(tm) Programming Language                                             #
#                                                                           #
# Copyright (c) 2026-present tinyBigGAMES(tm) LLC                           #
# All Rights Reserved.                                                      #
#                                                                           #
# https://adamlang.org                                                      #
#                                                                           #
# SPDX-License-Identifier: MPL-2.0                                          #
#                                                                           #
# This Source Code Form is subject to the terms of the                      #
# Mozilla Public License, v. 2.0. If a copy of the MPL                      #
# was not distributed with this file, You can obtain one                    #
# at https://mozilla.org/MPL/2.0/.                                          #
#---------------------------------------------------------------------------#
# build-adam.sh -- Adam builds itself, then adamtest, into this folder      #
#                                                                           #
# build-adam.cmd's linux twin: one line over adam --dev-build-adam          #
# (Adam.Dev.BuildAdam, the same job on every host). It ends with BUILD OK,  #
# or BUILD FAILED - <step> and exit code 1.                                 #
#                                                                           #
# Usage:   ./build-adam.sh                                                  #
#############################################################################

exec "$(dirname "$0")/adam" --dev-build-adam
