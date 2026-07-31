import { Module } from '@nestjs/common';
import { SdkProtocolController } from './sdk-protocol.controller';
import { SdkProtocolService } from './sdk-protocol.service';

@Module({
  controllers: [SdkProtocolController],
  providers: [SdkProtocolService],
})
export class SdkProtocolModule {}
