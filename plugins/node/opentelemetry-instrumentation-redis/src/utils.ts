/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type * as redisTypes from 'redis';
import {
  context,
  Tracer,
  SpanKind,
  Span,
  SpanStatusCode,
} from '@opentelemetry/api';
import { RedisCommand, RedisPluginClientTypes } from './types';
import { EventEmitter } from 'events';
import { RedisInstrumentation } from './';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';

const endSpan = (span: Span, err?: Error | null) => {
  if (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err.message,
    });
  }
  span.end();
};

export const getTracedCreateClient = (tracer: Tracer, original: Function) => {
  return function createClientTrace(this: redisTypes.RedisClient) {
    const client: redisTypes.RedisClient = original.apply(this, arguments);
    return context.bind(client);
  };
};

export const getTracedCreateStreamTrace = (
  tracer: Tracer,
  original: Function
) => {
  return function create_stream_trace(this: redisTypes.RedisClient) {
    if (!this.stream) {
      Object.defineProperty(this, 'stream', {
        get() {
          return this._patched_redis_stream;
        },
        set(val: EventEmitter) {
          context.bind(val);
          this._patched_redis_stream = val;
        },
      });
    }
    return original.apply(this, arguments);
  };
};

export const getTracedInternalSendCommand = (
  tracer: Tracer,
  original: Function
) => {
  return function internal_send_command_trace(
    this: RedisPluginClientTypes,
    cmd?: RedisCommand
  ) {
    // New versions of redis (2.4+) use a single options object
    // instead of named arguments
    if (arguments.length === 1 && typeof cmd === 'object') {
      const span = tracer.startSpan(
        `${RedisInstrumentation.COMPONENT}-${cmd.command}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            [SemanticAttributes.DB_SYSTEM]: RedisInstrumentation.COMPONENT,
            [SemanticAttributes.DB_STATEMENT]: cmd.command,
          },
        }
      );

      // Set attributes for not explicitly typed RedisPluginClientTypes
      if (this.options) {
        span.setAttributes({
          [SemanticAttributes.NET_PEER_NAME]: this.options.host,
          [SemanticAttributes.NET_PEER_PORT]: this.options.port,
        });
      }
      if (this.address) {
        span.setAttribute(
          SemanticAttributes.NET_PEER_IP,
          `redis://${this.address}`
        );
      }

      const originalCallback = arguments[0].callback;
      if (originalCallback) {
        (arguments[0] as RedisCommand).callback = function callback<T>(
          this: unknown,
          err: Error | null,
          _reply: T
        ) {
          endSpan(span, err);
          return originalCallback.apply(this, arguments);
        };
      }
      try {
        // Span will be ended in callback
        return original.apply(this, arguments);
      } catch (rethrow) {
        endSpan(span, rethrow);
        throw rethrow; // rethrow after ending span
      }
    }

    // We don't know how to trace this call, so don't start/stop a span
    return original.apply(this, arguments);
  };
};
