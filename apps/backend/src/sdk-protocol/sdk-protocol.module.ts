import { Module } from '@nestjs/common';
import { SdkProtocolController } from './sdk-protocol.controller';
import { SdkProtocolService } from './sdk-protocol.service';
import { SdkProtocolRepository } from './sdk-protocol.repository';

@Module({
  controllers: [SdkProtocolController],
  providers: [SdkProtocolService, SdkProtocolRepository],
})
export class SdkProtocolModule {}
