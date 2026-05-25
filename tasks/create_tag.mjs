import { execSync } from 'child_process';
import fs from 'fs';

class CreateTag
{
  create()
  {
    try
    {
      const package_json = JSON.parse(fs.readFileSync('./package.json'));
      const app_version = package_json.version;
      const tag = `v${app_version}`;

      if (this.tag_exists(tag))
      {
        console.log(`Tag ${tag} already exists locally, pushing it.`);
      }
      else
      {
        execSync(`git tag -a "${tag}" -m "Release Version ${app_version}"`, { stdio: 'inherit' });
      }

      execSync(`git push origin "${tag}"`, { stdio: 'inherit' });
      console.log(`Pushed ${tag}. GitHub Actions will build and publish the release.`);
    }
    catch (e)
    {
      console.error('Error:', e.message || e);
      process.exit(1);
    }
  }

  tag_exists(tag)
  {
    try
    {
      execSync(`git rev-parse -q --verify "refs/tags/${tag}"`, { stdio: 'ignore' });
      return true;
    }
    catch
    {
      return false;
    }
  }
}

new CreateTag().create();
