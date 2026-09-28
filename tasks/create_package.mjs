import { execSync } from 'child_process';

class CreatePackage
{
  create()
  {
    try
    {
      execSync('vsce package', { stdio: 'inherit' });
    }
    catch (e)
    {
      console.error('Error:', e);
      process.exitCode = 1;
    }
  }
}

const create_tag = new CreatePackage();
create_tag.create();
