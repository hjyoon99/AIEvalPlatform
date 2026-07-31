import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from 'prisma/prisma.module';
import { EvalModule } from './eval/eval.module';
import { ProjectModule } from './project/project.module';
import { SdkProtocolModule } from './sdk-protocol/sdk-protocol.module';

@Module({
  imports: [PrismaModule, EvalModule, ProjectModule, SdkProtocolModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
