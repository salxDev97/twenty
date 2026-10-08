import { NestFactory } from '@nestjs/core';

import { ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { LoggerService } from 'src/engine/core-modules/logger/logger.service';
import { loadOnemaAccessRulesOrThrow } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { shouldCaptureException } from 'src/engine/utils/global-exception-handler.util';
import 'src/instrument';
import { QueueWorkerModule } from 'src/queue-worker/queue-worker.module';
import { enableValidationMetadataCache } from 'src/utils/enable-validation-metadata-cache.util';

async function bootstrap() {
  let exceptionHandlerService: ExceptionHandlerService | undefined;
  let loggerService: LoggerService | undefined;

  enableValidationMetadataCache();
  // Onema fork (ADR-003): same fail-fast as the server, the worker runs the ORM too
  loadOnemaAccessRulesOrThrow();

  try {
    const app = await NestFactory.createApplicationContext(QueueWorkerModule, {
      bufferLogs: process.env.LOGGER_IS_BUFFER_ENABLED === 'true',
    });

    loggerService = app.get(LoggerService);
    exceptionHandlerService = app.get(ExceptionHandlerService);

    app.useLogger(loggerService ?? false);

    app.enableShutdownHooks();
  } catch (err) {
    loggerService?.error(err?.message, err?.name);

    if (shouldCaptureException(err)) {
      exceptionHandlerService?.captureExceptions([err]);
    }

    throw err;
  }
}
void bootstrap();
